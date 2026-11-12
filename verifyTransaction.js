
// ============================================================
// verifyTransaction.js — v3.1
// Safer USDT BEP20 deposit verification and processing
// ============================================================

import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
import { WALLET_CONFIG } from "./wallet.js";
import {
    db, ref, get, set, push, runTransaction, remove, update
} from "./firebase.js";

const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const activeVerifications = new Map();

const RELATIVE_TOLERANCE = 0.0001;
const ABSOLUTE_TOLERANCE = 0.001;

function normalizeTxHash(txHash) {
    if (typeof txHash !== "string") return null;
    const value = txHash.trim();
    return /^0x[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null;
}

function makeToken() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function safeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// ============================================================
// AMOUNT CHECK
// ============================================================

export function amountsMatch(userAmount, chainAmount) {
    const a = safeNumber(userAmount);
    const b = safeNumber(chainAmount);

    if (a === null || b === null || a <= 0 || b <= 0) {
        return false;
    }

    const diff = Math.abs(a - b);
    const tolerance = Math.max(
        b * RELATIVE_TOLERANCE,
        ABSOLUTE_TOLERANCE
    );

    return diff <= tolerance;
}

// ============================================================
// RPC PROVIDER WITH FAILOVER AND TIMEOUT
// ============================================================

async function getProvider() {
    let lastError = null;

    for (const rpcUrl of WALLET_CONFIG.RPC_ENDPOINTS || []) {
        let provider = null;
        let timeoutId = null;

        try {
            provider = new ethers.JsonRpcProvider(rpcUrl);

            const timeoutMs = Number(WALLET_CONFIG.RPC_TIMEOUT) || 10000;

            const blockNumber = await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(
                        () => reject(new Error("RPC timeout")),
                        timeoutMs
                    );
                })
            ]);

            if (!Number.isFinite(Number(blockNumber))) {
                throw new Error("Invalid RPC block response");
            }

            const network = await Promise.race([
                provider.getNetwork(),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(
                        () => reject(new Error("RPC network timeout")),
                        timeoutMs
                    );
                })
            ]);

            if (Number(network.chainId) !== 56) {
                throw new Error("RPC endpoint is not BNB Smart Chain");
            }

            if (timeoutId) clearTimeout(timeoutId);
            return provider;

        } catch (error) {
            lastError = error;

            if (timeoutId) clearTimeout(timeoutId);

            if (provider) {
                try {
                    provider.destroy();
                } catch (_) {}
            }

            console.warn(`RPC ${rpcUrl} failed:`, error.message);
        }
    }

    throw new Error(
        `All BSC RPC endpoints failed. ${lastError?.message || ""}`
    );
}

// ============================================================
// PROCESSING LOCK WITH OWNERSHIP TOKEN
// ============================================================

async function acquireProcessingLock(txHash, uid, amount) {
    const lockRef = ref(db, `processingTransactions/${txHash}`);
    const claimToken = makeToken();

    try {
        const result = await runTransaction(lockRef, (currentData) => {
            const now = Date.now();
            const staleTime = Number(WALLET_CONFIG.STALE_LOCK_TIMEOUT) || 600000;

            if (currentData !== null) {
                const lockTime = Number(currentData.timestamp) || 0;

                if (now - lockTime <= staleTime) {
                    return;
                }
            }

            return {
                uid,
                amount: Number(amount),
                timestamp: now,
                status: "processing",
                claimToken
            };
        });

        if (!result.committed) return null;

        const saved = result.snapshot.val();

        if (!saved || saved.claimToken !== claimToken) {
            return null;
        }

        return claimToken;

    } catch (error) {
        console.error("Error acquiring processing lock:", error);
        return null;
    }
}

async function releaseProcessingLock(txHash, claimToken) {
    if (!claimToken) return false;

    const lockRef = ref(db, `processingTransactions/${txHash}`);

    try {
        const result = await runTransaction(lockRef, (currentData) => {
            if (!currentData || currentData.claimToken !== claimToken) {
                return;
            }
            return null;
        });

        return result.committed;

    } catch (error) {
        console.error("Error releasing processing lock:", error);
        return false;
    }
}

async function refreshProcessingLock(txHash, claimToken) {
    if (!claimToken) return false;

    const lockRef = ref(db, `processingTransactions/${txHash}`);

    try {
        const result = await runTransaction(lockRef, (currentData) => {
            if (!currentData || currentData.claimToken !== claimToken) {
                return;
            }

            return {
                ...currentData,
                timestamp: Date.now()
            };
        });

        return result.committed;

    } catch (error) {
        console.error("Error refreshing processing lock:", error);
        return false;
    }
}

// ============================================================
// DUPLICATE TRANSACTION CHECK — FAIL CLOSED
// ============================================================

export async function checkDuplicateTransaction(txHash) {
    const normalizedHash = normalizeTxHash(txHash);

    if (!normalizedHash) {
        return {
            isDuplicate: true,
            error: "Invalid transaction hash."
        };
    }

    try {
        const snap = await get(
            ref(db, `usedTransactions/${normalizedHash}`)
        );

        if (snap.exists()) {
            return {
                isDuplicate: true,
                data: snap.val()
            };
        }

        return { isDuplicate: false };

    } catch (error) {
        console.error("Error checking duplicate:", error);

        return {
            isDuplicate: true,
            error: "Could not check transaction history. Please try again."
        };
    }
}

// ============================================================
// PARSE USDT TRANSFERS TO OUR DEPOSIT WALLET
// Select only incoming transfers to the configured wallet.
// If different senders are found, reject as ambiguous.
// ============================================================

function parseTransferFromReceipt(receipt) {
    const iface = new ethers.Interface(ERC20_ABI);
    const expectedToken = WALLET_CONFIG.USDT_CONTRACT.toLowerCase();
    const expectedWallet = WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase();

    const incoming = [];

    for (const log of receipt.logs || []) {
        if (!log.address || log.address.toLowerCase() !== expectedToken) {
            continue;
        }

        try {
            const parsedLog = iface.parseLog(log);

            if (!parsedLog || parsedLog.name !== "Transfer") {
                continue;
            }

            const from = parsedLog.args.from;
            const to = parsedLog.args.to;
            const value = parsedLog.args.value;

            if (!from || !to || typeof value !== "bigint" || value <= 0n) {
                continue;
            }

            if (to.toLowerCase() !== expectedWallet) {
                continue;
            }

            incoming.push({
                from,
                to,
                value,
                tokenContract: log.address
            });

        } catch (_) {
            continue;
        }
    }

    if (incoming.length === 0) {
        return {
            transferEvent: null,
            fromAddress: null,
            toAddress: null,
            transferAmount: null,
            tokenContract: null,
            ambiguousIncoming: false
        };
    }

    const senders = [
        ...new Set(incoming.map(item => item.from.toLowerCase()))
    ];

    // Do not combine funds from different senders into one deposit.
    if (senders.length !== 1) {
        return {
            transferEvent: null,
            fromAddress: null,
            toAddress: expectedWallet,
            transferAmount: null,
            tokenContract: WALLET_CONFIG.USDT_CONTRACT,
            ambiguousIncoming: true
        };
    }

    const totalAmount = incoming.reduce(
        (sum, item) => sum + item.value,
        0n
    );

    return {
        transferEvent: incoming[0],
        fromAddress: incoming[0].from,
        toAddress: incoming[0].to,
        transferAmount: totalAmount,
        tokenContract: incoming[0].tokenContract,
        ambiguousIncoming: false
    };
}

// ============================================================
// VERIFY TRANSACTION ON BNB SMART CHAIN
// ============================================================

export async function verifyTransaction(txHash, expectedAmount) {
    const normalizedHash = normalizeTxHash(txHash);

    if (!normalizedHash) {
        return {
            success: false,
            error: "Invalid TXID. Please enter the complete 66-character transaction hash."
        };
    }

    if (activeVerifications.has(normalizedHash)) {
        return {
            success: false,
            error: "This transaction is already being verified. Please wait."
        };
    }

    activeVerifications.set(normalizedHash, Date.now());

    let provider = null;

    try {
        provider = await getProvider();

        let receipt = null;
        let retries = 3;

        while (retries > 0 && !receipt) {
            try {
                receipt = await provider.getTransactionReceipt(normalizedHash);

                if (!receipt) {
                    retries--;
                    if (retries > 0) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }

            } catch (error) {
                retries--;

                if (retries === 0) throw error;

                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        if (!receipt) {
            return {
                success: false,
                error: "Transaction not found on BNB Smart Chain. Please check the TXID or try again later."
            };
        }

        if (receipt.status !== 1) {
            return {
                success: false,
                error: "Transaction failed on BNB Smart Chain."
            };
        }

        const parsed = parseTransferFromReceipt(receipt);

        if (parsed.ambiguousIncoming) {
            return {
                success: false,
                error: "This TXID contains incoming USDT transfers from multiple wallets. Please contact support for manual verification."
            };
        }

        if (!parsed.transferEvent) {
            return {
                success: false,
                error: "No USDT transfer to the configured deposit wallet was found in this transaction."
            };
        }

        if (
            parsed.tokenContract?.toLowerCase() !==
            WALLET_CONFIG.USDT_CONTRACT.toLowerCase()
        ) {
            return {
                success: false,
                error: "Invalid USDT token contract."
            };
        }

        if (
            parsed.toAddress?.toLowerCase() !==
            WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()
        ) {
            return {
                success: false,
                error: `Wrong receiver wallet. Expected ${WALLET_CONFIG.DEPOSIT_WALLET}.`
            };
        }

        // BNB Smart Chain USDT uses 18 decimals.
        const exactAmount = ethers.formatUnits(parsed.transferAmount, 18);
        const actualAmount = Number(exactAmount);

        if (!Number.isFinite(actualAmount) || actualAmount <= 0) {
            return {
                success: false,
                error: "Invalid USDT amount found on blockchain."
            };
        }

        if (
            expectedAmount !== undefined &&
            expectedAmount !== null &&
            String(expectedAmount).trim() !== ""
        ) {
            const enteredAmount = Number(expectedAmount);

            if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
                return {
                    success: false,
                    error: "Please enter a valid deposit amount."
                };
            }

            if (!amountsMatch(enteredAmount, actualAmount)) {
                return {
                    success: false,
                    error: `Amount mismatch. You entered ${enteredAmount} USDT but blockchain shows ${exactAmount} USDT.`,
                    amountMismatch: true,
                    blockchainAmount: exactAmount,
                    userAmount: enteredAmount
                };
            }
        }

        const currentBlock = await provider.getBlockNumber();

        // Include the block containing the transaction.
        const confirmations = currentBlock - receipt.blockNumber + 1;

        if (confirmations < WALLET_CONFIG.MIN_CONFIRMATIONS) {
            return {
                success: false,
                error: `Waiting for confirmations... (${confirmations}/${WALLET_CONFIG.MIN_CONFIRMATIONS})`,
                pending: true,
                confirmations,
                currentBlock,
                blockNumber: receipt.blockNumber,
                blockchainAmount: exactAmount
            };
        }

        return {
            success: true,
            verified: true,
            receipt: {
                blockNumber: receipt.blockNumber,
                confirmations,
                from: parsed.fromAddress,
                to: parsed.toAddress,
                amount: actualAmount,
                exactAmount,
                tokenContract: parsed.tokenContract,
                txHash: normalizedHash,
                blockHash: receipt.blockHash,
                gasUsed: receipt.gasUsed?.toString() || "0",
                status: receipt.status
            }
        };

    } catch (error) {
        console.error("Verification error:", error);

        return {
            success: false,
            error: `Verification failed: ${error.message || "Unknown error"}`
        };

    } finally {
        activeVerifications.delete(normalizedHash);

        if (provider) {
            try {
                provider.destroy();
            } catch (_) {}
        }
    }
}

// ============================================================
// RELEASE ONLY OUR OWN INCOMPLETE CLAIM
// ============================================================

async function releaseUsedClaim(txHash, claimToken) {
    if (!claimToken) return false;

    const usedRef = ref(db, `usedTransactions/${txHash}`);

    try {
        const result = await runTransaction(usedRef, (currentData) => {
            if (
                !currentData ||
                currentData.claimToken !== claimToken ||
                currentData.status !== "claimed"
            ) {
                return;
            }

            return null;
        });

        return result.committed;

    } catch (error) {
        console.error("Could not release used transaction claim:", error);
        return false;
    }
}

// ============================================================
// PROCESS DEPOSIT — CLAIM, CREDIT, COMPLETE
// ============================================================

export async function processDeposit(uid, txHash, amount, receipt) {
    const normalizedHash = normalizeTxHash(txHash);

    if (!normalizedHash) {
        return {
            success: false,
            error: "Invalid transaction hash."
        };
    }

    if (!uid || !receipt || receipt.status !== 1) {
        return {
            success: false,
            error: "Invalid user or unverified transaction receipt."
        };
    }

    const finalAmount = Number(receipt.amount || amount);

    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        return {
            success: false,
            error: "Invalid deposit amount."
        };
    }

    if (
        receipt.to?.toLowerCase() !==
        WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()
    ) {
        return {
            success: false,
            error: "Deposit receiver does not match the configured wallet."
        };
    }

    if (
        receipt.tokenContract?.toLowerCase() !==
        WALLET_CONFIG.USDT_CONTRACT.toLowerCase()
    ) {
        return {
            success: false,
            error: "Deposit token contract does not match configured USDT."
        };
    }

    const usedRef = ref(db, `usedTransactions/${normalizedHash}`);
    const claimToken = makeToken();
    let claimOwned = false;

    try {
        // STEP 1: Atomically claim this TXID.
        const claimResult = await runTransaction(
            usedRef,
            (currentData) => {
                const now = Date.now();
                const staleTime =
                    Number(WALLET_CONFIG.STALE_LOCK_TIMEOUT) || 600000;

                if (currentData !== null) {
                    if (currentData.status === "completed") {
                        return;
                    }

                    const claimTime = Number(currentData.timestamp) || 0;

                    // Another active claim must not be overwritten.
                    if (now - claimTime <= staleTime) {
                        return;
                    }
                }

                return {
                    uid,
                    amount: finalAmount,
                    timestamp: now,
                    blockNumber: receipt.blockNumber,
                    txHash: normalizedHash,
                    status: "claimed",
                    claimToken
                };
            }
        );

        if (!claimResult.committed) {
            const existing = claimResult.snapshot.val();

            if (
                existing &&
                existing.uid === uid &&
                existing.status === "completed"
            ) {
                return {
                    success: false,
                    error: "This transaction was already credited to your account.",
                    alreadyCredited: true
                };
            }

            return {
                success: false,
                error: "This transaction is already used or being processed. Please try again later."
            };
        }

        claimOwned = true;

        // STEP 2: Atomically credit the user's balance.
        const userRef = ref(db, `users/${uid}`);

        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) {
                return;
            }

            const transactions = {
                ...(currentData.transactions || {})
            };

            // Secondary duplicate guard.
            for (const key of Object.keys(transactions)) {
                const tx = transactions[key];

                if (
                    tx &&
                    tx.type === "deposit" &&
                    String(tx.txHash || "").toLowerCase() === normalizedHash &&
                    tx.status === "success"
                ) {
                    return;
                }
            }

            const currentBalance = Number(currentData.depositWallet) || 0;

            if (!Number.isFinite(currentBalance) || currentBalance < 0) {
                return;
            }

            const newBalance = currentBalance + finalAmount;

            const txId =
                "tx_" +
                Date.now() +
                "_" +
                Math.random().toString(36).slice(2, 10);

            transactions[txId] = {
                type: "deposit",
                status: "success",
                amount: finalAmount,
                txHash: normalizedHash,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                tokenContract: receipt.tokenContract,
                confirmations: receipt.confirmations,
                timestamp: Date.now(),
                date: new Date().toDateString(),
                description:
                    `Deposit of ${finalAmount.toFixed(6)} USDT verified on blockchain`
            };

            return {
                ...currentData,
                depositWallet: newBalance,
                transactions
            };
        });

        if (!result.committed) {
            // Check whether the TX was already credited.
            const latestUserSnap = await get(userRef);

            if (!latestUserSnap.exists()) {
                await releaseUsedClaim(normalizedHash, claimToken);
                claimOwned = false;

                return {
                    success: false,
                    error: "User account was not found. Deposit was not credited."
                };
            }

            const latestUser = latestUserSnap.val();
            const transactions = latestUser.transactions || {};

            const alreadyCredited = Object.values(transactions).some(tx =>
                tx &&
                tx.type === "deposit" &&
                String(tx.txHash || "").toLowerCase() === normalizedHash &&
                tx.status === "success"
            );

            if (alreadyCredited) {
                await update(usedRef, {
                    status: "completed",
                    completedAt: Date.now(),
                    alreadyApplied: true
                });

                return {
                    success: false,
                    error: "This transaction was already credited to your account.",
                    alreadyCredited: true
                };
            }

            await releaseUsedClaim(normalizedHash, claimToken);
            claimOwned = false;

            return {
                success: false,
                error: "Balance was not updated. Please retry verification."
            };
        }

        // STEP 3: Mark the TXID completed after balance credit.
        try {
            await runTransaction(usedRef, (currentData) => {
                if (
                    !currentData ||
                    currentData.claimToken !== claimToken
                ) {
                    return;
                }

                return {
                    ...currentData,
                    status: "completed",
                    completedAt: Date.now()
                };
            });

        } catch (error) {
            // Balance is already credited. Do not delete the claim here.
            console.error("Could not mark used TX as completed:", error);
        }

        // STEP 4: Save deposit history.
        // This is a separate history record; balance credit has already happened.
        try {
            const historyRef = push(ref(db, "depositHistory"));

            await set(historyRef, {
                uid,
                txHash: normalizedHash,
                amount: finalAmount,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                tokenContract: receipt.tokenContract,
                timestamp: Date.now(),
                status: "success"
            });

        } catch (error) {
            console.error("Could not save deposit history:", error);
        }

        return {
            success: true,
            newBalance: result.snapshot.val().depositWallet,
            amountCredited: finalAmount,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error("Error processing deposit:", error);

        // Release only the claim created by this exact process.
        // If balance was already credited, the user's transaction guard
        // prevents the same TXID from being credited a second time.
        if (claimOwned) {
            await releaseUsedClaim(normalizedHash, claimToken);
        }

        return {
            success: false,
            error: error.message || "Failed to process deposit."
        };
    }
}

// ============================================================
// COMPLETE DEPOSIT FLOW
// ============================================================

export async function completeDeposit(
    uid,
    txHash,
    amount,
    onPending,
    onSuccess,
    onError
) {
    const normalizedHash = normalizeTxHash(txHash);

    if (!normalizedHash) {
        return {
            success: false,
            error: "Invalid TXID. Enter the complete transaction hash."
        };
    }

    if (!uid) {
        return {
            success: false,
            error: "Please login again before verifying your deposit."
        };
    }

    console.log("Starting secure deposit verification...");

    try {
        // STEP 1: Check duplicate status.
        const duplicateCheck =
            await checkDuplicateTransaction(normalizedHash);

        if (duplicateCheck.error) {
            return {
                success: false,
                error: duplicateCheck.error
            };
        }

        if (duplicateCheck.isDuplicate) {
            const d = duplicateCheck.data;

            if (
                d &&
                d.uid === uid &&
                d.status === "completed"
            ) {
                return {
                    success: false,
                    error: "This transaction was already credited to your account.",
                    alreadyCredited: true
                };
            }

            return {
                success: false,
                error: "This transaction hash has already been used. Duplicate deposits are not allowed."
            };
        }

        // STEP 2: Acquire processing lock.
        const lockToken = await acquireProcessingLock(
            normalizedHash,
            uid,
            amount
        );

        if (!lockToken) {
            return {
                success: false,
                error: "This transaction is already being processed. Please wait."
            };
        }

        // STEP 3: Verify on blockchain.
        const verification = await verifyTransaction(
            normalizedHash,
            amount
        );

        if (verification.amountMismatch) {
            await releaseProcessingLock(normalizedHash, lockToken);
            return verification;
        }

        if (verification.pending) {
            if (onPending) {
                onPending(
                    verification.confirmations,
                    verification.currentBlock,
                    verification.blockNumber
                );
            }

            const pollingResult = await startAutoPolling(
                uid,
                normalizedHash,
                amount,
                lockToken,
                onPending,
                onSuccess,
                onError
            );

            // Keep the lock if still pending so the page can resume it.
            if (!pollingResult.pending) {
                await releaseProcessingLock(normalizedHash, lockToken);
            }

            return pollingResult;
        }

        if (!verification.success) {
            await releaseProcessingLock(normalizedHash, lockToken);
            return verification;
        }

        // STEP 4: Process verified deposit.
        const result = await processDeposit(
            uid,
            normalizedHash,
            amount,
            verification.receipt
        );

        await releaseProcessingLock(normalizedHash, lockToken);

        if (result.success && onSuccess) {
            onSuccess(
                result.newBalance,
                result.amountCredited,
                result.blockNumber
            );
        }

        return result;

    } catch (error) {
        console.error("Complete deposit error:", error);

        if (onError) {
            try {
                onError(error.message);
            } catch (_) {}
        }

        return {
            success: false,
            error: error.message || "Failed to complete deposit."
        };
    }
}

// ============================================================
// AUTO POLLING FOR CONFIRMATIONS
// ============================================================

async function startAutoPolling(
    uid,
    txHash,
    amount,
    lockToken,
    onPending,
    onSuccess,
    onError
) {
    let attempts = 0;

    const maxAttempts =
        Number(WALLET_CONFIG.MAX_POLLING_ATTEMPTS) || 60;

    const intervalMs =
        Number(WALLET_CONFIG.POLLING_INTERVAL) || 15000;

    return new Promise((resolve) => {
        let resolved = false;
        let polling = false;

        const safeResolve = (value) => {
            if (resolved) return;
            resolved = true;
            clearInterval(pollInterval);
            resolve(value);
        };

        const pollInterval = setInterval(async () => {
            if (resolved || polling) return;

            polling = true;
            attempts++;

            try {
                const lockSnap = await get(
                    ref(db, `processingTransactions/${txHash}`)
                );

                if (
                    !lockSnap.exists() ||
                    lockSnap.val().claimToken !== lockToken
                ) {
                    safeResolve({
                        success: false,
                        error: "Processing lock expired or changed. Please verify the TXID again."
                    });
                    return;
                }

                await refreshProcessingLock(txHash, lockToken);

                const verification = await verifyTransaction(
                    txHash,
                    amount
                );

                if (verification.amountMismatch) {
                    safeResolve(verification);
                    return;
                }

                if (verification.pending) {
                    if (onPending) {
                        onPending(
                            verification.confirmations,
                            verification.currentBlock,
                            verification.blockNumber
                        );
                    }

                    if (attempts >= maxAttempts) {
                        safeResolve({
                            success: false,
                            error: "Still waiting for confirmations. You can safely check this TXID again later.",
                            pending: true,
                            confirmations: verification.confirmations
                        });
                    }

                    return;
                }

                if (!verification.success) {
                    safeResolve(verification);
                    return;
                }

                const result = await processDeposit(
                    uid,
                    txHash,
                    amount,
                    verification.receipt
                );

                if (result.success && onSuccess) {
                    onSuccess(
                        result.newBalance,
                        result.amountCredited,
                        result.blockNumber
                    );
                }

                safeResolve(result);

            } catch (error) {
                console.error("Polling error:", error);

                safeResolve({
                    success: false,
                    error: error.message || "Polling failed."
                });

            } finally {
                polling = false;
            }

        }, intervalMs);
    });
}

// ============================================================
// CLEANUP STALE PROCESSING LOCKS
// ============================================================

export async function cleanupStaleLocks() {
    try {
        const locksSnap = await get(
            ref(db, "processingTransactions")
        );

        if (!locksSnap.exists()) return;

        const locks = locksSnap.val() || {};
        const now = Date.now();

        const staleTime =
            Number(WALLET_CONFIG.STALE_LOCK_TIMEOUT) || 600000;

        for (const [txHash, lockData] of Object.entries(locks)) {
            const timestamp = Number(lockData?.timestamp) || 0;

            if (now - timestamp > staleTime) {
                const lockRef = ref(
                    db,
                    `processingTransactions/${txHash}`
                );

                // Recheck timestamp atomically before removing.
                await runTransaction(lockRef, (currentData) => {
                    if (!currentData) return;

                    const currentTime =
                        Number(currentData.timestamp) || 0;

                    if (now - currentTime <= staleTime) {
                        return;
                    }

                    return null;
                });

                console.log(`Checked stale processing lock: ${txHash}`);
            }
        }

    } catch (error) {
        console.error("Error cleaning up stale locks:", error);
    }
}

// ============================================================
// FIND PENDING VERIFICATIONS FOR LOGGED-IN USER
// ============================================================

export async function checkPendingVerifications(uid) {
    if (!uid) return [];

    try {
        const locksSnap = await get(
            ref(db, "processingTransactions")
        );

        if (!locksSnap.exists()) return [];

        const locks = locksSnap.val() || {};
        const pendingTxs = [];

        for (const [txHash, lockData] of Object.entries(locks)) {
            if (!lockData || lockData.uid !== uid) continue;

            const usedSnap = await get(
                ref(db, `usedTransactions/${txHash}`)
            );

            if (usedSnap.exists()) {
                const usedData = usedSnap.val();

                // Remove the processing lock only when the deposit
                // is confirmed as completed.
                if (usedData?.status === "completed") {
                    await remove(
                        ref(db, `processingTransactions/${txHash}`)
                    );
                    continue;
                }

                // A claimed transaction may need recovery.
                // Do not delete its lock or claim automatically.
            }

            pendingTxs.push({
                txHash,
                lockData
            });
        }

        return pendingTxs;

    } catch (error) {
        console.error("Error checking pending verifications:", error);
        return [];
    }
}
