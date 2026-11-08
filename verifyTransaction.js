import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
import { WALLET_CONFIG } from "./wallet.js";
import { 
    db, 
    ref, 
    get, 
    set, 
    push, 
    runTransaction, 
    remove,
    update
} from "./firebase.js";

// ERC20 ABI for USDT transfer events
const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Browser memory cache for active verifications
const activeVerifications = new Map();

// ============================================================
// 🔒 EXACT USDT AMOUNT MATCHING
// BSC USDT contract uses 18 decimals. Compare integer base units,
// never floating-point numbers, so a wrong amount cannot pass by tolerance.
// ============================================================
const USDT_DECIMALS = 18;

export function amountsMatch(userAmount, chainAmount) {
    try {
        const entered = String(userAmount ?? "").trim();
        const actual = String(chainAmount ?? "").trim();
        if (!entered || !actual || !/^\\d+(\\.\\d+)?$/.test(entered)) return false;
        if (Number(entered) <= 0 || Number(actual) <= 0) return false;
        return ethers.parseUnits(entered, USDT_DECIMALS) === ethers.parseUnits(actual, USDT_DECIMALS);
    } catch {
        return false;
    }
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
// 🔒 ACQUIRE PROCESSING LOCK - ATOMIC
// ============================================================
async function acquireProcessingLock(txHash, uid, amount) {
    const lockRef = ref(db, `processingTransactions/${txHash}`);
    
    try {
        const result = await runTransaction(lockRef, (currentData) => {
            if (currentData !== null) {
                const now = Date.now();
                const lockTime = currentData.timestamp || 0;
                
                if (now - lockTime > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                    return {
                        uid: uid,
                        timestamp: now,
                        status: 'processing',
                        amount: amount
                    };
                }
                return;
            }
            
            return {
                uid: uid,
                timestamp: Date.now(),
                status: 'processing',
                amount: amount
            };
        });
        
        return result.committed;
    } catch (error) {
        console.error('Error acquiring processing lock:', error);
        return false;
    }
}

// ============================================================
// 🔒 RELEASE PROCESSING LOCK
// ============================================================
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
// 🔒 CHECK DUPLICATE TRANSACTION
// ============================================================
export async function checkDuplicateTransaction(txHash, uid = null) {
    const snap = await get(ref(db, `usedTransactions/${txHash}`));
    if (!snap.exists()) return { isDuplicate: false };

    const data = snap.val() || {};
    // A completed claim is never reusable. A pending claim can only be resumed
    // by the same account that originally acquired it.
    const isDuplicate = data.status === "completed" || (data.uid && uid && data.uid !== uid);
    return { isDuplicate, data };
}

// ============================================================
// 🔥 PARSE THE USDT TRANSFER TO OUR DEPOSIT WALLET
// Select only logs from the configured token contract and destination.
// If more than one matching transfer exists, accept them only when they
// originate from the same sender, then sum their exact raw token amounts.
// ============================================================
function parseTransferFromReceipt(receipt) {
    const iface = new ethers.Interface(ERC20_ABI);
    const matches = [];

    for (const log of (receipt.logs || [])) {
        if (!log.address || log.address.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) continue;
        try {
            const parsedLog = iface.parseLog(log);
            if (
                parsedLog &&
                parsedLog.name === "Transfer" &&
                parsedLog.args.to.toLowerCase() === WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()
            ) {
                matches.push({
                    fromAddress: parsedLog.args.from,
                    toAddress: parsedLog.args.to,
                    transferAmount: parsedLog.args.value,
                    tokenContract: log.address
                });
            }
        } catch {
            // Ignore unrelated logs.
        }
    }

    if (matches.length === 0) {
        return { transferEvent: null, fromAddress: null, toAddress: null, transferAmount: null, tokenContract: null };
    }

    const sender = matches[0].fromAddress.toLowerCase();
    if (matches.some(item => item.fromAddress.toLowerCase() !== sender)) {
        return { ambiguous: true, transferEvent: null, fromAddress: null, toAddress: WALLET_CONFIG.DEPOSIT_WALLET, transferAmount: null, tokenContract: WALLET_CONFIG.USDT_CONTRACT };
    }

    const totalRawAmount = matches.reduce((sum, item) => sum + item.transferAmount, 0n);
    return {
        transferEvent: matches[0],
        fromAddress: matches[0].fromAddress,
        toAddress: WALLET_CONFIG.DEPOSIT_WALLET,
        transferAmount: totalRawAmount,
        tokenContract: WALLET_CONFIG.USDT_CONTRACT
    };
}

// ============================================================
// 🔥 PARSE USDT TRANSFER FROM RECEIPT
// ============================================================
function parseTransferFromReceipt(receipt) {
    const iface = new ethers.Interface(ERC20_ABI);
    let transferEvent = null;
    let fromAddress = null;
    let toAddress = null;
    let transferAmount = null;
    let tokenContract = null;

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) {
            continue;
        }
        
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
        } catch (e) {
            continue;
        }
    }

    return { transferEvent, fromAddress, toAddress, transferAmount, tokenContract };
}

// ============================================================
// 🔒 VERIFY TRANSACTION ON BLOCKCHAIN (FULLY FIXED)
// ============================================================
// 🔥 KEY FIX:
//   - Amount & wallet validation ab confirmations se PEHLE hoti hai
//   - Agar amount mismatch hai, तुरंत error return karta hai
//   - Confirmations baad me check hoti hain (sirf agar amount sahi ho)
// ============================================================
export async function verifyTransaction(txHash, expectedAmount) {
    const normalizedHash = String(txHash || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(normalizedHash)) {
        return { success: false, error: "Invalid transaction hash. Enter the complete 0x transaction hash." };
    }
    if (activeVerifications.has(normalizedHash)) {
        return { success: false, error: "This transaction is already being verified. Please wait." };
    }

    activeVerifications.set(normalizedHash, Date.now());

    try {
        const provider = await getProvider();
        let receipt = null;
        let retries = 3;

        while (retries > 0 && !receipt) {
            try {
                receipt = await provider.getTransactionReceipt(normalizedHash);
                if (!receipt) {
                    retries--;
                    if (retries > 0) await new Promise(resolve => setTimeout(resolve, 1500));
                }
            } catch (error) {
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        if (!receipt) return { success: false, error: "Transaction not found. Check the hash and try again." };
        if (receipt.status !== 1) return { success: false, error: "Transaction failed on blockchain." };

        const parsed = parseTransferFromReceipt(receipt);
        if (!parsed.transferEvent) {
            if (parsed.ambiguous) {
                return { success: false, error: "This transaction has multiple USDT transfers from different senders to the deposit wallet. Please contact support for manual review." };
            }
            return {
                success: false,
                error: `No USDT (BEP20) transfer to our deposit wallet was found. Verify the receiver address and USDT contract.`
            };
        }

        const actualAmount = ethers.formatUnits(parsed.transferAmount, USDT_DECIMALS);
        if (expectedAmount !== undefined && expectedAmount !== null && String(expectedAmount).trim() !== "") {
            if (!amountsMatch(expectedAmount, actualAmount)) {
                return {
                    success: false,
                    amountMismatch: true,
                    blockchainAmount: actualAmount,
                    userAmount: String(expectedAmount),
                    error: `Amount mismatch. You entered ${String(expectedAmount)} USDT but blockchain shows ${actualAmount} USDT.`
                };
            }
        }

        const currentBlock = await provider.getBlockNumber();
        // Include the transaction's own block as confirmation #1.
        const confirmations = currentBlock - receipt.blockNumber + 1;

        if (confirmations < WALLET_CONFIG.MIN_CONFIRMATIONS) {
            return {
                success: false,
                error: `Waiting for confirmations... (${confirmations}/${WALLET_CONFIG.MIN_CONFIRMATIONS})`,
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
        console.error("Verification error:", error);
        return { success: false, error: `Verification failed: ${error.message}` };
    } finally {
        activeVerifications.delete(normalizedHash);
    }
}

// ============================================================
// 🔒 PROCESS DEPOSIT - ATOMIC
// ============================================================
export async function processDeposit(uid, txHash, amount, receipt) {
    const normalizedHash = String(txHash || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(normalizedHash)) throw new Error("Invalid transaction hash.");

    // Only the blockchain-verified amount may be credited. Never fall back to
    // the amount typed by the user.
    const finalAmount = Number(receipt && receipt.amount);
    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        throw new Error("Verified blockchain amount is missing or invalid.");
    }

    const claimRef = ref(db, `usedTransactions/${normalizedHash}`);
    const claimResult = await runTransaction(claimRef, current => {
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

        // Allow the original account to resume an interrupted credit operation.
        // Never let a different account take over an existing claim.
        if (current.uid === uid && current.status === "processing") return current;
        return;
    });

    if (!claimResult.committed) {
        const existing = claimResult.snapshot.val();
        if (existing && existing.uid === uid && existing.status === "completed") {
            throw new Error("This transaction has already been credited to your account.");
        }
        throw new Error("This transaction hash has already been claimed or used. Duplicate deposits are not allowed.");
    }

    try {
        const userRef = ref(db, `users/${uid}`);
        let wasAlreadyCredited = false;

        const userResult = await runTransaction(userRef, currentData => {
            if (!currentData) return;

            const transactions = currentData.transactions || {};
            const existingEntry = Object.values(transactions).find(tx =>
                tx &&
                tx.type === "deposit" &&
                String(tx.txHash || "").toLowerCase() === normalizedHash &&
                tx.status === "success"
            );

            if (existingEntry) {
                wasAlreadyCredited = true;
                return currentData;
            }

            const currentBalance = Number(currentData.depositWallet) || 0;
            const newBalance = currentBalance + finalAmount;
            const txId = "deposit_" + normalizedHash.slice(2);

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
                description: `Deposit of ${finalAmount.toFixed(6)} USDT verified on blockchain`
            };

            return {
                ...currentData,
                depositWallet: newBalance,
                transactions
            };
        });

        if (!userResult.committed || !userResult.snapshot.exists()) {
            throw new Error("Could not safely update the user deposit balance. The transaction claim has been retained for safe retry.");
        }

        const newBalance = Number(userResult.snapshot.val().depositWallet) || 0;

        // Mark completed only after the user's transaction record and balance
        // are confirmed in the same per-user RTDB transaction.
        await update(claimRef, {
            uid,
            amount: finalAmount,
            txHash: normalizedHash,
            blockNumber: receipt.blockNumber,
            status: "completed",
            completedAt: Date.now()
        });

        // Fixed TXID key prevents duplicate history rows on safe retries.
        await set(ref(db, `depositHistory/${normalizedHash}`), {
            uid,
            txHash: normalizedHash,
            amount: finalAmount,
            blockNumber: receipt.blockNumber,
            from: receipt.from,
            to: receipt.to,
            timestamp: Date.now(),
            status: "success"
        });

        return {
            success: true,
            newBalance,
            amountCredited: finalAmount,
            blockNumber: receipt.blockNumber,
            alreadyCredited: wasAlreadyCredited
        };
    } catch (error) {
        // Keep the claim in "processing". The same UID can retry; another UID
        // cannot steal the TXID. This avoids reopening a TXID after uncertain
        // network outcomes where the user balance may already have committed.
        console.error("Error processing claimed deposit:", error);
        throw error;
    }
}

// ============================================================
// 🔒 COMPLETE DEPOSIT FLOW (FIXED)
// ============================================================
export async function completeDeposit(uid, txHash, amount, onPending, onSuccess, onError) {
    console.log('🔒 Starting secure deposit flow...');
    
    try {
        // STEP 1: Check duplicate
        const duplicateCheck = await checkDuplicateTransaction(String(txHash).trim().toLowerCase(), uid);
        if (duplicateCheck.isDuplicate) {
            return {
                success: false,
                error: "❌ This transaction hash has already been used. Duplicate deposits are not allowed."
            };
        }
        
        // STEP 2: Acquire processing lock
        const lockAcquired = await acquireProcessingLock(txHash, uid, amount);
        if (!lockAcquired) {
            return {
                success: false,
                error: "⏳ This transaction is already being processed. Please wait."
            };
        }
        
        try {
            // STEP 3: Verify on blockchain
            const verification = await verifyTransaction(txHash, amount);
            console.log('Verification result:', verification);
            
            // 🔥 STEP 4: Handle AMOUNT MISMATCH — do NOT enter pending loop!
            if (verification.amountMismatch) {
                await releaseProcessingLock(txHash);
                return verification;  // Return mismatch immediately
            }
            
            // STEP 5: Handle pending (only for valid amounts waiting for confirmations)
            if (verification.pending) {
                if (onPending) {
                    onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                }
                
                const pollingResult = await startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError);
                await releaseProcessingLock(txHash);
                return pollingResult;
            }
            
            // STEP 6: Handle other failures
            if (!verification.success) {
                await releaseProcessingLock(txHash);
                return verification;
            }
            
            // STEP 7: Process deposit
            try {
                const result = await processDeposit(uid, txHash, amount, verification.receipt);
                await releaseProcessingLock(txHash);
                
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
                await releaseProcessingLock(txHash);
                return {
                    success: false,
                    error: error.message || "Failed to process deposit"
                };
            }
            
        } catch (error) {
            await releaseProcessingLock(txHash);
            throw error;
        }
        
    } catch (error) {
        console.error('Complete deposit error:', error);
        return {
            success: false,
            error: error.message || "Failed to complete deposit"
        };
    }
}

// ============================================================
// 🔒 AUTO-POLLING FOR PENDING TRANSACTIONS (FIXED)
// ============================================================
async function startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError) {
    let attempts = 0;
    
    return new Promise((resolve) => {
        const pollInterval = setInterval(async () => {
            attempts++;
            
            try {
                const lockSnap = await get(ref(db, `processingTransactions/${txHash}`));
                if (!lockSnap.exists()) {
                    clearInterval(pollInterval);
                    resolve({
                        success: false,
                        error: "Processing was interrupted. Please try again."
                    });
                    return;
                }
                
                const verification = await verifyTransaction(txHash, amount);
                
                // 🔥 If amount mismatch occurs during polling, stop immediately
                if (verification.amountMismatch) {
                    clearInterval(pollInterval);
                    resolve(verification);
                    return;
                }
                
                if (verification.pending) {
                    if (onPending) {
                        onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                    }
                    
                    if (attempts >= WALLET_CONFIG.MAX_POLLING_ATTEMPTS) {
                        clearInterval(pollInterval);
                        resolve({
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
                    resolve(verification);
                    return;
                }
                
                try {
                    const result = await processDeposit(uid, txHash, amount, verification.receipt);
                    
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
                        error: error.message || "Failed to process deposit"
                    });
                }
                
            } catch (error) {
                clearInterval(pollInterval);
                resolve({
                    success: false,
                    error: error.message || "Polling failed"
                });
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
                
                pendingTxs.push({
                    txHash: txHash,
                    lockData: lockData
                });
            }
        }
        
        return pendingTxs;
    } catch (error) {
        console.error('Error checking pending verifications:', error);
        return [];
    }
}
