import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
import { WALLET_CONFIG } from "./wallet.js";
import {
    db,
    ref,
    get,
    set,
    runTransaction,
    remove,
    update
} from "./firebase.js";

// ERC20 ABI
const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Browser memory cache
const activeVerifications = new Map();

const USDT_DECIMALS = 18;

// ============================================================
// EXACT USDT AMOUNT MATCHING
// ============================================================

export function amountsMatch(userAmount, chainAmount) {
    try {
        const entered = String(userAmount ?? "").trim();
        const actual = String(chainAmount ?? "").trim();

        if (!entered || !actual) return false;

        const decimalPattern = /^\d+(?:\.\d{1,18})?$/;

        if (
            !decimalPattern.test(entered) ||
            !decimalPattern.test(actual)
        ) {
            return false;
        }

        const enteredUnits = ethers.parseUnits(
            entered,
            USDT_DECIMALS
        );

        const actualUnits = ethers.parseUnits(
            actual,
            USDT_DECIMALS
        );

        return (
            enteredUnits > 0n &&
            actualUnits > 0n &&
            enteredUnits === actualUnits
        );

    } catch {
        return false;
    }
}

// ============================================================
// RPC PROVIDER WITH FAILOVER
// ============================================================

async function getProvider() {
    let lastError = null;

    for (const rpcUrl of WALLET_CONFIG.RPC_ENDPOINTS) {
        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl);

            provider.timeout = WALLET_CONFIG.RPC_TIMEOUT;

            await Promise.race([
                provider.getBlockNumber(),

                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("RPC timeout")),
                        WALLET_CONFIG.RPC_TIMEOUT
                    )
                )
            ]);

            return provider;

        } catch (error) {
            lastError = error;

            console.warn(
                `RPC ${rpcUrl} failed:`,
                error.message
            );
        }
    }

    throw new Error(
        `All RPC endpoints failed. Last error: ${lastError?.message}`
    );
}

// ============================================================
// ACQUIRE PROCESSING LOCK - ATOMIC
// ============================================================

async function acquireProcessingLock(txHash, uid, amount) {
    const lockRef = ref(
        db,
        `processingTransactions/${txHash}`
    );

    try {
        const result = await runTransaction(
            lockRef,
            (currentData) => {

                if (currentData !== null) {
                    const now = Date.now();

                    const lockTime = Number(
                        currentData.timestamp || 0
                    );

                    const isStale =
                        now - lockTime >
                        WALLET_CONFIG.STALE_LOCK_TIMEOUT;

                    const belongsToSameUser =
                        currentData.uid === uid;

                    if (isStale || belongsToSameUser) {
                        return {
                            uid,
                            timestamp: now,
                            status: "processing",
                            amount
                        };
                    }

                    return;
                }

                return {
                    uid,
                    timestamp: Date.now(),
                    status: "processing",
                    amount
                };
            }
        );

        return result.committed;

    } catch (error) {
        console.error(
            "Error acquiring processing lock:",
            error
        );

        return false;
    }
}

// ============================================================
// RELEASE PROCESSING LOCK
// ============================================================

async function releaseProcessingLock(txHash) {
    try {
        await remove(
            ref(db, `processingTransactions/${txHash}`)
        );

        return true;

    } catch (error) {
        console.error(
            "Error releasing processing lock:",
            error
        );

        return false;
    }
}

// ============================================================
// CHECK DUPLICATE TRANSACTION
// ============================================================

export async function checkDuplicateTransaction(
    txHash,
    uid = null
) {
    const snap = await get(
        ref(db, `usedTransactions/${txHash}`)
    );

    if (!snap.exists()) {
        return {
            isDuplicate: false
        };
    }

    const data = snap.val() || {};

    const isDuplicate =
        data.status === "completed" ||
        (
            data.uid &&
            uid &&
            data.uid !== uid
        );

    return {
        isDuplicate,
        data
    };
}

// ============================================================
// PARSE USDT TRANSFER FROM RECEIPT
// ONLY OUR OFFICIAL USDT CONTRACT AND DEPOSIT WALLET
// ============================================================

function parseTransferFromReceipt(receipt) {
    const iface = new ethers.Interface(ERC20_ABI);

    const matches = [];

    for (const log of (receipt.logs || [])) {

        if (
            !log.address ||
            log.address.toLowerCase() !==
            WALLET_CONFIG.USDT_CONTRACT.toLowerCase()
        ) {
            continue;
        }

        try {
            const parsedLog = iface.parseLog(log);

            if (
                parsedLog &&
                parsedLog.name === "Transfer" &&
                parsedLog.args.to.toLowerCase() ===
                WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()
            ) {

                matches.push({
                    fromAddress: parsedLog.args.from,
                    toAddress: parsedLog.args.to,
                    transferAmount: parsedLog.args.value,
                    tokenContract: log.address
                });
            }

        } catch {
            // Ignore unrelated logs
        }
    }

    if (matches.length === 0) {
        return {
            transferEvent: null,
            fromAddress: null,
            toAddress: null,
            transferAmount: null,
            tokenContract: null
        };
    }

    const sender =
        matches[0].fromAddress.toLowerCase();

    if (
        matches.some(
            item =>
                item.fromAddress.toLowerCase() !== sender
        )
    ) {
        return {
            ambiguous: true,
            transferEvent: null,
            fromAddress: null,
            toAddress: WALLET_CONFIG.DEPOSIT_WALLET,
            transferAmount: null,
            tokenContract: WALLET_CONFIG.USDT_CONTRACT
        };
    }

    const totalRawAmount = matches.reduce(
        (sum, item) => sum + item.transferAmount,
        0n
    );

    return {
        transferEvent: matches[0],
        fromAddress: matches[0].fromAddress,
        toAddress: WALLET_CONFIG.DEPOSIT_WALLET,
        transferAmount: totalRawAmount,
        tokenContract: WALLET_CONFIG.USDT_CONTRACT
    };
}

// ============================================================
// VERIFY TRANSACTION ON BSC BLOCKCHAIN
// ============================================================

export async function verifyTransaction(
    txHash,
    expectedAmount
) {
    const normalizedHash = String(
        txHash || ""
    ).trim().toLowerCase();

    if (!/^0x[a-f0-9]{64}$/.test(normalizedHash)) {
        return {
            success: false,
            error: "Invalid transaction hash. Enter the complete 0x transaction hash."
        };
    }

    if (activeVerifications.has(normalizedHash)) {
        return {
            success: false,
            error: "This transaction is already being verified. Please wait."
        };
    }

    activeVerifications.set(
        normalizedHash,
        Date.now()
    );

    try {
        const provider = await getProvider();

        let receipt = null;

        let retries = 3;

        while (retries > 0 && !receipt) {
            try {
                receipt = await provider.getTransactionReceipt(
                    normalizedHash
                );

                if (!receipt) {
                    retries--;

                    if (retries > 0) {
                        await new Promise(
                            resolve => setTimeout(resolve, 1500)
                        );
                    }
                }

            } catch (error) {
                retries--;

                if (retries === 0) {
                    throw error;
                }

                await new Promise(
                    resolve => setTimeout(resolve, 1000)
                );
            }
        }

        if (!receipt) {
            return {
                success: false,
                error: "Transaction not found. Check the hash and try again."
            };
        }

        if (receipt.status !== 1) {
            return {
                success: false,
                error: "Transaction failed on blockchain."
            };
        }

        const parsed = parseTransferFromReceipt(receipt);

        if (!parsed.transferEvent) {

            if (parsed.ambiguous) {
                return {
                    success: false,
                    error: "This transaction has multiple USDT transfers from different senders to the deposit wallet. Please contact support for manual review."
                };
            }

            return {
                success: false,
                error: "No USDT (BEP20) transfer to our deposit wallet was found. Verify the receiver address and USDT contract."
            };
        }

        const actualAmount = ethers.formatUnits(
            parsed.transferAmount,
            USDT_DECIMALS
        );

        // EXACT AMOUNT MATCH
        if (
            expectedAmount !== undefined &&
            expectedAmount !== null &&
            String(expectedAmount).trim() !== ""
        ) {

            if (
                !amountsMatch(
                    expectedAmount,
                    actualAmount
                )
            ) {
                return {
                    success: false,
                    amountMismatch: true,
                    blockchainAmount: actualAmount,
                    userAmount: String(expectedAmount),

                    error:
                        `Amount mismatch. You entered ${String(expectedAmount)} USDT but blockchain shows ${actualAmount} USDT.`
                };
            }
        }

        // CONFIRMATIONS
        const currentBlock =
            await provider.getBlockNumber();

        const confirmations =
            currentBlock - receipt.blockNumber + 1;

        if (
            confirmations <
            WALLET_CONFIG.MIN_CONFIRMATIONS
        ) {
            return {
                success: false,
                error:
                    `Waiting for confirmations... (${confirmations}/${WALLET_CONFIG.MIN_CONFIRMATIONS})`,

                pending: true,
                confirmations,
                currentBlock,
                blockNumber: receipt.blockNumber,
                blockchainAmount: actualAmount
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

                tokenContract: parsed.tokenContract,

                txHash: normalizedHash,
                blockHash: receipt.blockHash,

                gasUsed: receipt.gasUsed.toString(),

                status: receipt.status
            }
        };

    } catch (error) {
        console.error(
            "Verification error:",
            error
        );

        return {
            success: false,
            error: `Verification failed: ${error.message}`
        };

    } finally {
        activeVerifications.delete(normalizedHash);
    }
}

// ============================================================
// PROCESS DEPOSIT - ATOMIC TXID CLAIM
// ============================================================

export async function processDeposit(
    uid,
    txHash,
    amount,
    receipt
) {
    const normalizedHash = String(
        txHash || ""
    ).trim().toLowerCase();

    if (!/^0x[a-f0-9]{64}$/.test(normalizedHash)) {
        throw new Error("Invalid transaction hash.");
    }

    // Always use actual blockchain amount
    const finalAmount = Number(
        receipt && receipt.amount
    );

    if (
        !Number.isFinite(finalAmount) ||
        finalAmount <= 0
    ) {
        throw new Error(
            "Verified blockchain amount is missing or invalid."
        );
    }

    const claimRef = ref(
        db,
        `usedTransactions/${normalizedHash}`
    );

    const claimResult = await runTransaction(
        claimRef,
        current => {

            if (current === null) {
                return {
                    uid,
                    amount: finalAmount,
                    txHash: normalizedHash,
                    blockNumber: receipt.blockNumber,
                    status: "processing",
                    timestamp: Date.now()
                };
            }

            // Same account can safely resume interrupted processing
            if (
                current.uid === uid &&
                current.status === "processing"
            ) {
                return current;
            }

            return;
        }
    );

    if (!claimResult.committed) {
        const existing =
            claimResult.snapshot.val();

        if (
            existing &&
            existing.uid === uid &&
            existing.status === "completed"
        ) {
            throw new Error(
                "This transaction has already been credited to your account."
            );
        }

        throw new Error(
            "This transaction hash has already been claimed or used. Duplicate deposits are not allowed."
        );
    }

    try {
        const userRef = ref(
            db,
            `users/${uid}`
        );

        let wasAlreadyCredited = false;

        const userResult = await runTransaction(
            userRef,
            currentData => {

                if (!currentData) {
                    return;
                }

                const transactions =
                    currentData.transactions || {};

                const existingEntry =
                    Object.values(transactions).find(
                        tx =>
                            tx &&
                            tx.type === "deposit" &&
                            String(
                                tx.txHash || ""
                            ).toLowerCase() === normalizedHash &&
                            tx.status === "success"
                    );

                if (existingEntry) {
                    wasAlreadyCredited = true;
                    return currentData;
                }

                const currentBalance =
                    Number(
                        currentData.depositWallet
                    ) || 0;

                const newBalance =
                    currentBalance + finalAmount;

                const txId =
                    "deposit_" + normalizedHash.slice(2);

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
            }
        );

        if (
            !userResult.committed ||
            !userResult.snapshot.exists()
        ) {
            throw new Error(
                "Could not safely update the user deposit balance. The transaction claim has been retained for safe retry."
            );
        }

        const newBalance =
            Number(
                userResult.snapshot.val().depositWallet
            ) || 0;

        // SAVE DEPOSIT HISTORY
        await set(
            ref(
                db,
                `depositHistory/${normalizedHash}`
            ),
            {
                uid,

                txHash: normalizedHash,

                amount: finalAmount,

                blockNumber: receipt.blockNumber,

                from: receipt.from,
                to: receipt.to,

                tokenContract: receipt.tokenContract,

                confirmations: receipt.confirmations,

                timestamp: Date.now(),

                status: "success"
            }
        );

        // MARK TXID COMPLETED
        await update(
            claimRef,
            {
                uid,

                amount: finalAmount,

                txHash: normalizedHash,

                blockNumber: receipt.blockNumber,

                status: "completed",

                completedAt: Date.now()
            }
        );

        return {
            success: true,

            newBalance,

            amountCredited: finalAmount,

            blockNumber: receipt.blockNumber,

            alreadyCredited: wasAlreadyCredited
        };

    } catch (error) {
        console.error(
            "Error processing claimed deposit:",
            error
        );

        // Retain processing claim for same-user safe retry
        throw error;
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
    console.log(
        "Starting secure deposit flow..."
    );

    const normalizedHash = String(
        txHash || ""
    ).trim().toLowerCase();

    try {
        if (!uid) {
            return {
                success: false,
                error: "Please sign in before making a deposit."
            };
        }

        if (!/^0x[a-f0-9]{64}$/.test(normalizedHash)) {
            return {
                success: false,
                error: "Invalid transaction hash. Enter the complete 0x transaction hash."
            };
        }

        // STEP 1: CHECK DUPLICATE
        const duplicateCheck =
            await checkDuplicateTransaction(
                normalizedHash,
                uid
            );

        if (duplicateCheck.isDuplicate) {
            return {
                success: false,
                error: "This transaction hash has already been used. Duplicate deposits are not allowed."
            };
        }

        // STEP 2: ACQUIRE LOCK
        const lockAcquired =
            await acquireProcessingLock(
                normalizedHash,
                uid,
                amount
            );

        if (!lockAcquired) {
            return {
                success: false,
                error: "This transaction is already being processed. Please wait."
            };
        }

        try {
            // STEP 3: VERIFY BLOCKCHAIN
            const verification =
                await verifyTransaction(
                    normalizedHash,
                    amount
                );

            console.log(
                "Verification result:",
                verification
            );

            // STEP 4: AMOUNT MISMATCH
            if (verification.amountMismatch) {
                await releaseProcessingLock(
                    normalizedHash
                );

                return verification;
            }

            // STEP 5: PENDING CONFIRMATIONS
            if (verification.pending) {

                if (onPending) {
                    onPending(
                        verification.confirmations,
                        verification.currentBlock,
                        verification.blockNumber
                    );
                }

                const pollingResult =
                    await startAutoPolling(
                        uid,
                        normalizedHash,
                        amount,
                        onPending,
                        onSuccess,
                        onError
                    );

                await releaseProcessingLock(
                    normalizedHash
                );

                return pollingResult;
            }

            // STEP 6: OTHER FAILURES
            if (!verification.success) {
                await releaseProcessingLock(
                    normalizedHash
                );

                return verification;
            }

            // STEP 7: PROCESS DEPOSIT
            try {
                const result =
                    await processDeposit(
                        uid,
                        normalizedHash,
                        amount,
                        verification.receipt
                    );

                await releaseProcessingLock(
                    normalizedHash
                );

                if (onSuccess) {
                    onSuccess(
                        result.newBalance,
                        result.amountCredited,
                        result.blockNumber
                    );
                }

                return {
                    success: true,
                    ...result
                };

            } catch (error) {
                await releaseProcessingLock(
                    normalizedHash
                );

                return {
                    success: false,
                    error:
                        error.message ||
                        "Failed to process deposit"
                };
            }

        } catch (error) {
            await releaseProcessingLock(
                normalizedHash
            );

            throw error;
        }

    } catch (error) {
        console.error(
            "Complete deposit error:",
            error
        );

        return {
            success: false,
            error:
                error.message ||
                "Failed to complete deposit"
        };
    }
}

// ============================================================
// AUTO POLLING FOR PENDING TRANSACTIONS
// ============================================================

async function startAutoPolling(
    uid,
    normalizedHash,
    amount,
    onPending,
    onSuccess,
    onError
) {
    let attempts = 0;

    return new Promise(resolve => {

        const pollInterval = setInterval(
            async () => {

                attempts++;

                try {
                    const lockSnap = await get(
                        ref(
                            db,
                            `processingTransactions/${normalizedHash}`
                        )
                    );

                    if (!lockSnap.exists()) {
                        clearInterval(pollInterval);

                        resolve({
                            success: false,
                            error: "Processing was interrupted. Please try again."
                        });

                        return;
                    }

                    const verification =
                        await verifyTransaction(
                            normalizedHash,
                            amount
                        );

                    // AMOUNT MISMATCH
                    if (verification.amountMismatch) {
                        clearInterval(pollInterval);

                        resolve(verification);

                        return;
                    }

                    // STILL PENDING
                    if (verification.pending) {

                        if (onPending) {
                            onPending(
                                verification.confirmations,
                                verification.currentBlock,
                                verification.blockNumber
                            );
                        }

                        if (
                            attempts >=
                            WALLET_CONFIG.MAX_POLLING_ATTEMPTS
                        ) {
                            clearInterval(pollInterval);

                            resolve({
                                success: false,

                                error:
                                    "Still waiting for confirmations. Please try again later.",

                                pending: true,

                                confirmations:
                                    verification.confirmations
                            });
                        }

                        return;
                    }

                    clearInterval(pollInterval);

                    if (!verification.success) {
                        resolve(verification);
                        return;
                    }

                    // PROCESS DEPOSIT
                    try {
                        const result =
                            await processDeposit(
                                uid,
                                normalizedHash,
                                amount,
                                verification.receipt
                            );

                        if (onSuccess) {
                            onSuccess(
                                result.newBalance,
                                result.amountCredited,
                                result.blockNumber
                            );
                        }

                        resolve({
                            success: true,
                            ...result
                        });

                    } catch (error) {
                        resolve({
                            success: false,
                            error:
                                error.message ||
                                "Failed to process deposit"
                        });
                    }

                } catch (error) {
                    clearInterval(pollInterval);

                    resolve({
                        success: false,
                        error:
                            error.message ||
                            "Polling failed"
                    });
                }

            },
            WALLET_CONFIG.POLLING_INTERVAL
        );
    });
}

// ============================================================
// CLEANUP STALE LOCKS
// ============================================================

export async function cleanupStaleLocks() {
    try {
        const locksSnap = await get(
            ref(db, "processingTransactions")
        );

        if (!locksSnap.exists()) return;

        const locks = locksSnap.val();

        const now = Date.now();

        for (
            const [txHash, lockData]
            of Object.entries(locks)
        ) {

            if (
                !lockData ||
                now - Number(lockData.timestamp || 0) <=
                WALLET_CONFIG.STALE_LOCK_TIMEOUT
            ) {
                continue;
            }

            const claimSnap = await get(
                ref(
                    db,
                    `usedTransactions/${txHash}`
                )
            );

            const claim = claimSnap.exists()
                ? (claimSnap.val() || {})
                : null;

            if (
                claim &&
                claim.status === "processing"
            ) {
                continue;
            }

            await remove(
                ref(
                    db,
                    `processingTransactions/${txHash}`
                )
            );

            console.log(
                `Cleaned up stale lock for ${txHash}`
            );
        }

    } catch (error) {
        console.error(
            "Error cleaning up stale locks:",
            error
        );
    }
}

// ============================================================
// CHECK PENDING VERIFICATIONS
// ============================================================

export async function checkPendingVerifications(uid) {
    try {
        const locksSnap = await get(
            ref(db, "processingTransactions")
        );

        if (!locksSnap.exists()) return [];

        const locks = locksSnap.val();

        const pendingTxs = [];

        for (
            const [txHash, lockData]
            of Object.entries(locks)
        ) {

            if (
                lockData &&
                lockData.uid === uid
            ) {

                const usedSnap = await get(
                    ref(
                        db,
                        `usedTransactions/${txHash}`
                    )
                );

                if (usedSnap.exists()) {

                    const usedData =
                        usedSnap.val() || {};

                    if (
                        usedData.status === "completed" ||
                        (
                            usedData.uid &&
                            usedData.uid !== uid
                        )
                    ) {
                        await remove(
                            ref(
                                db,
                                `processingTransactions/${txHash}`
                            )
                        );

                        continue;
                    }
                }

                pendingTxs.push({
                    txHash,
                    lockData
                });
            }
        }

        return pendingTxs;

    } catch (error) {
        console.error(
            "Error checking pending verifications:",
            error
        );

        return [];
    }
}
