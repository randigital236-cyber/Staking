// ============================================================
// verifyTransaction.js — v3.0 SECURE
// All critical bugs fixed
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

// ============================================================
// 🔥 AMOUNT TOLERANCE (Tightened)
// ============================================================
const RELATIVE_TOLERANCE = 0.0001;  // 0.01% (very tight)
const ABSOLUTE_TOLERANCE = 0.001;   // 0.001 USDT floor

export function amountsMatch(userAmount, chainAmount) {
    const a = Number(userAmount);
    const b = Number(chainAmount);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a <= 0 || b <= 0) return false;

    const diff = Math.abs(a - b);
    const tolerance = Math.max(b * RELATIVE_TOLERANCE, ABSOLUTE_TOLERANCE);
    return diff <= tolerance;
}

// ============================================================
// 🔒 GET RPC PROVIDER WITH FAILOVER
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
                    setTimeout(() => reject(new Error('RPC timeout')), WALLET_CONFIG.RPC_TIMEOUT)
                )
            ]);
            return provider;
        } catch (error) {
            lastError = error;
            console.warn(`RPC ${rpcUrl} failed:`, error.message);
            continue;
        }
    }
    throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message}`);
}

// ============================================================
// 🔒 PROCESSING LOCK (with UID ownership check)
// ============================================================
async function acquireProcessingLock(txHash, uid, amount) {
    const lockRef = ref(db, `processingTransactions/${txHash}`);

    try {
        const result = await runTransaction(lockRef, (currentData) => {
            const now = Date.now();

            if (currentData !== null) {
                const lockTime = currentData.timestamp || 0;
                const lockUid = currentData.uid;

                // 🔥 Same user + active lock → ABORT (double-click protection)
                if (lockUid === uid && (now - lockTime) < WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                    return; // abort
                }

                // Stale lock → take over
                if (now - lockTime > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                    return { uid, timestamp: now, status: 'processing', amount };
                }

                // Different user, active lock → abort
                return;
            }

            return { uid, timestamp: now, status: 'processing', amount };
        });

        return result.committed;
    } catch (error) {
        console.error('Error acquiring processing lock:', error);
        return false;
    }
}

async function releaseProcessingLock(txHash) {
    try {
        await remove(ref(db, `processingTransactions/${txHash}`));
        return true;
    } catch (error) {
        console.error('Error releasing processing lock:', error);
        return false;
    }
}

// ============================================================
// 🔒 CHECK DUPLICATE (cross-user safe)
// ============================================================
export async function checkDuplicateTransaction(txHash) {
    try {
        const snap = await get(ref(db, `usedTransactions/${txHash}`));
        if (snap.exists()) {
            return { isDuplicate: true, data: snap.val() };
        }
        return { isDuplicate: false };
    } catch (error) {
        console.error("Error checking duplicate:", error);
        return { isDuplicate: false };
    }
}

// ============================================================
// 🔥 PARSE USDT TRANSFER
// ============================================================
function parseTransferFromReceipt(receipt) {
    const iface = new ethers.Interface(ERC20_ABI);
    let transferEvent = null;
    let fromAddress = null;
    let toAddress = null;
    let transferAmount = null;
    let tokenContract = null;

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) continue;
        try {
            const parsedLog = iface.parseLog(log);
            if (parsedLog && parsedLog.name === 'Transfer') {
                fromAddress = parsedLog.args.from;
                toAddress = parsedLog.args.to;
                transferAmount = parsedLog.args.value;
                tokenContract = log.address;
                transferEvent = parsedLog;
                break;
            }
        } catch (e) { continue; }
    }
    return { transferEvent, fromAddress, toAddress, transferAmount, tokenContract };
}

// ============================================================
// 🔒 VERIFY TRANSACTION
// ============================================================
export async function verifyTransaction(txHash, expectedAmount) {
    if (activeVerifications.has(txHash)) {
        return { success: false, error: "This transaction is already being verified. Please wait." };
    }

    activeVerifications.set(txHash, Date.now());

    try {
        const provider = await getProvider();

        // Get receipt with retry
        let receipt = null;
        let retries = 3;
        while (retries > 0 && !receipt) {
            try {
                receipt = await provider.getTransactionReceipt(txHash);
                if (!receipt) {
                    await new Promise(r => setTimeout(r, 2000));
                    retries--;
                } else break;
            } catch (e) {
                retries--;
                if (retries === 0) throw e;
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!receipt) {
            return {
                success: false,
                error: "Transaction not found. यह TXID BSC पर नहीं मिला। Check करें या 1-2 minute बाद try करें।"
            };
        }

        if (receipt.status !== 1) {
            return { success: false, error: "Transaction failed on blockchain. यह transaction BSC पर fail हो चुका है।" };
        }

        // Parse USDT transfer
        const parsed = parseTransferFromReceipt(receipt);

        if (!parsed.transferEvent) {
            return { success: false, error: "No USDT transfer found in this transaction. सही USDT (BEP20) TXID use करें।" };
        }

        if (parsed.tokenContract?.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) {
            return {
                success: false,
                error: `Invalid token. Expected USDT (${WALLET_CONFIG.USDT_CONTRACT}) but got ${parsed.tokenContract || 'unknown'}.`
            };
        }

        if (parsed.toAddress?.toLowerCase() !== WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()) {
            return {
                success: false,
                error: `Wrong receiver wallet. Expected ${WALLET_CONFIG.DEPOSIT_WALLET} but got ${parsed.toAddress}.`
            };
        }

        // Amount check (BEFORE confirmations)
        const actualAmount = parseFloat(ethers.formatUnits(parsed.transferAmount, 18));

        if (expectedAmount && Number(expectedAmount) > 0) {
            if (!amountsMatch(expectedAmount, actualAmount)) {
                return {
                    success: false,
                    error: `Amount mismatch. You entered ${Number(expectedAmount)} USDT but blockchain shows ${actualAmount} USDT.`,
                    amountMismatch: true,
                    blockchainAmount: actualAmount,
                    userAmount: Number(expectedAmount)
                };
            }
        }

        // Confirmations check
        const currentBlock = await provider.getBlockNumber();
        const confirmations = currentBlock - receipt.blockNumber;

        if (confirmations < WALLET_CONFIG.MIN_CONFIRMATIONS) {
            return {
                success: false,
                error: `Waiting for confirmations... (${confirmations}/${WALLET_CONFIG.MIN_CONFIRMATIONS})`,
                pending: true,
                confirmations: confirmations,
                currentBlock: currentBlock,
                blockNumber: receipt.blockNumber,
                blockchainAmount: actualAmount
            };
        }

        // ✅ ALL PASS
        return {
            success: true,
            verified: true,
            receipt: {
                blockNumber: receipt.blockNumber,
                confirmations: confirmations,
                from: parsed.fromAddress,
                to: parsed.toAddress,
                amount: actualAmount,
                tokenContract: parsed.tokenContract,
                txHash: txHash,
                blockHash: receipt.blockHash,
                gasUsed: receipt.gasUsed.toString(),
                status: receipt.status
            }
        };

    } catch (error) {
        console.error("Verification error:", error);
        return { success: false, error: `Verification failed: ${error.message}` };
    } finally {
        activeVerifications.delete(txHash);
    }
}

// ============================================================
// 🔥🔥🔥 CRITICAL FIX: processDeposit — DUPLICATE CHECK NOW WORKS
// ============================================================
export async function processDeposit(uid, txHash, amount, receipt) {
    try {
        const finalAmount = (receipt && receipt.amount) ? Number(receipt.amount) : Number(amount);

        // ============================================================
        // 🔥 STEP 0: ATOMIC usedTransactions CLAIM (cross-user safe)
        // ============================================================
        const usedRef = ref(db, `usedTransactions/${txHash}`);
        const claimResult = await runTransaction(usedRef, (currentData) => {
            if (currentData !== null) {
                return; // abort — already used
            }
            return {
                uid: uid,
                amount: finalAmount,
                timestamp: Date.now(),
                blockNumber: receipt.blockNumber,
                status: 'claimed'
            };
        });

        if (!claimResult.committed) {
            // Already used by someone (or same user)
            const existing = claimResult.snapshot.val();
            if (existing && existing.uid === uid && existing.status === 'completed') {
                return { success: false, error: "This transaction was already credited to your account.", alreadyCredited: true };
            }
            return { success: false, error: "❌ This transaction hash has already been used. Duplicate deposits are not allowed." };
        }

        // ============================================================
        // 🔥 STEP 1: Credit user balance (atomic)
        // ============================================================
        const userRef = ref(db, `users/${uid}`);
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData;

            const transactions = currentData.transactions || {};

            // Secondary duplicate guard (in case of race)
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx.type === 'deposit' && tx.txHash === txHash && tx.status === 'success') {
                    return; // ✅ ABORT (not return currentData)
                }
            }

            const currentBalance = Number(currentData.depositWallet) || 0;
            const newBalance = currentBalance + finalAmount;

            const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
            transactions[txId] = {
                type: 'deposit',
                status: 'success',
                amount: finalAmount,
                txHash: txHash,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                tokenContract: receipt.tokenContract,
                confirmations: receipt.confirmations,
                timestamp: Date.now(),
                date: new Date().toDateString(),
                description: `Deposit of ${finalAmount.toFixed(6)} USDT verified on blockchain`
            };

            return {
                ...currentData,
                depositWallet: newBalance,
                transactions: transactions
            };
        });

        if (!result.committed) {
            // Balance already credited earlier — release the claim
            await update(usedRef, { status: 'completed', alreadyApplied: true }).catch(() => {});
            return { success: false, error: "Deposit already processed for this user.", alreadyCredited: true };
        }

        // ============================================================
        // STEP 2: Mark claim as completed
        // ============================================================
        try {
            await update(usedRef, {
                status: 'completed',
                completedAt: Date.now()
            });
        } catch (err) {
            console.warn('Could not update claim status:', err);
            // Balance already credited — safe
        }

        // ============================================================
        // STEP 3: Deposit history
        // ============================================================
        try {
            const newHistoryRef = push(ref(db, `depositHistory`));
            await set(newHistoryRef, {
                uid, txHash,
                amount: finalAmount,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                timestamp: Date.now(),
                status: 'success'
            });
        } catch (err) {
            console.warn('Could not save deposit history:', err);
        }

        return {
            success: true,
            newBalance: result.snapshot.val().depositWallet,
            amountCredited: finalAmount,
            blockNumber: receipt.blockNumber
        };

    } catch (error) {
        console.error("Error processing deposit:", error);
        // Try to release claim so user can retry
        try {
            const usedSnap = await get(ref(db, `usedTransactions/${txHash}`));
            if (usedSnap.exists() && usedSnap.val().status === 'claimed') {
                await remove(ref(db, `usedTransactions/${txHash}`));
            }
        } catch (_) {}
        throw error;
    }
}

// ============================================================
// 🔒 COMPLETE DEPOSIT FLOW
// ============================================================
export async function completeDeposit(uid, txHash, amount, onPending, onSuccess, onError) {
    console.log('🔒 Starting secure deposit flow...');

    try {
        // STEP 1: Duplicate check
        const duplicateCheck = await checkDuplicateTransaction(txHash);
        if (duplicateCheck.isDuplicate) {
            const d = duplicateCheck.data;
            if (d && d.uid === uid && d.status === 'completed') {
                return { success: false, error: "✅ This transaction was already credited to your account.", alreadyCredited: true };
            }
            return {
                success: false,
                error: "❌ This transaction hash has already been used. Duplicate deposits are not allowed."
            };
        }

        // STEP 2: Acquire lock
        const lockAcquired = await acquireProcessingLock(txHash, uid, amount);
        if (!lockAcquired) {
            return { success: false, error: "⏳ This transaction is already being processed. Please wait." };
        }

        try {
            // STEP 3: Verify
            const verification = await verifyTransaction(txHash, amount);
            console.log('Verification result:', verification);

            // Amount mismatch
            if (verification.amountMismatch) {
                await releaseProcessingLock(txHash);
                return verification;
            }

            // Pending (await confirmations)
            if (verification.pending) {
                if (onPending) {
                    onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                }
                const pollingResult = await startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError);
                await releaseProcessingLock(txHash);
                return pollingResult;
            }

            if (!verification.success) {
                await releaseProcessingLock(txHash);
                return verification;
            }

            // Process deposit
            try {
                const result = await processDeposit(uid, txHash, amount, verification.receipt);
                await releaseProcessingLock(txHash);

                if (result.success && onSuccess) {
                    onSuccess(result.newBalance, result.amountCredited, result.blockNumber);
                }

                return result;
            } catch (error) {
                await releaseProcessingLock(txHash);
                return { success: false, error: error.message || "Failed to process deposit" };
            }

        } catch (error) {
            await releaseProcessingLock(txHash);
            throw error;
        }

    } catch (error) {
        console.error('Complete deposit error:', error);
        return { success: false, error: error.message || "Failed to complete deposit" };
    }
}

// ============================================================
// 🔒 AUTO-POLLING (memory-leak safe)
// ============================================================
async function startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError) {
    let attempts = 0;

    return new Promise((resolve) => {
        let resolved = false;
        const safeResolve = (value) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
        };

        const pollInterval = setInterval(async () => {
            attempts++;
            try {
                const lockSnap = await get(ref(db, `processingTransactions/${txHash}`));
                if (!lockSnap.exists()) {
                    clearInterval(pollInterval);
                    safeResolve({ success: false, error: "Processing was interrupted. Please try again." });
                    return;
                }

                const verification = await verifyTransaction(txHash, amount);

                if (verification.amountMismatch) {
                    clearInterval(pollInterval);
                    safeResolve(verification);
                    return;
                }

                if (verification.pending) {
                    if (onPending) {
                        onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                    }
                    if (attempts >= WALLET_CONFIG.MAX_POLLING_ATTEMPTS) {
                        clearInterval(pollInterval);
                        safeResolve({
                            success: false,
                            error: `Still waiting for confirmations. Please try again later.`,
                            pending: true,
                            confirmations: verification.confirmations
                        });
                    }
                    return;
                }

                clearInterval(pollInterval);

                if (!verification.success) {
                    safeResolve(verification);
                    return;
                }

                try {
                    const result = await processDeposit(uid, txHash, amount, verification.receipt);
                    if (result.success && onSuccess) {
                        onSuccess(result.newBalance, result.amountCredited, result.blockNumber);
                    }
                    safeResolve(result);
                } catch (error) {
                    safeResolve({ success: false, error: error.message || "Failed to process deposit" });
                }
            } catch (error) {
                clearInterval(pollInterval);
                safeResolve({ success: false, error: error.message || "Polling failed" });
            }
        }, WALLET_CONFIG.POLLING_INTERVAL);
    });
}

// ============================================================
// 🔒 CLEANUP STALE LOCKS
// ============================================================
export async function cleanupStaleLocks() {
    try {
        const locksSnap = await get(ref(db, 'processingTransactions'));
        if (!locksSnap.exists()) return;
        const locks = locksSnap.val();
        const now = Date.now();
        for (const [txHash, lockData] of Object.entries(locks)) {
            if (now - lockData.timestamp > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                await remove(ref(db, `processingTransactions/${txHash}`));
                console.log(`🧹 Cleaned up stale lock for ${txHash}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up stale locks:', error);
    }
}

// ============================================================
// 🔒 CHECK PENDING VERIFICATIONS
// ============================================================
export async function checkPendingVerifications(uid) {
    try {
        const locksSnap = await get(ref(db, 'processingTransactions'));
        if (!locksSnap.exists()) return [];
        const locks = locksSnap.val();
        const pendingTxs = [];
        for (const [txHash, lockData] of Object.entries(locks)) {
            if (lockData.uid === uid) {
                const usedSnap = await get(ref(db, `usedTransactions/${txHash}`));
                if (usedSnap.exists()) {
                    await remove(ref(db, `processingTransactions/${txHash}`));
                    continue;
                }
                pendingTxs.push({ txHash, lockData });
            }
        }
        return pendingTxs;
    } catch (error) {
        console.error('Error checking pending verifications:', error);
        return [];
    }
}
