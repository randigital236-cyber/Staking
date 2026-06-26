// verifyTransaction.js
import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
import { WALLET_CONFIG } from "./wallet.js";
import { 
    db, 
    ref, 
    get, 
    set, 
    push, 
    runTransaction, 
    remove
} from "./firebase.js";

// ERC20 ABI for USDT transfer events
const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Browser memory cache for active verifications (prevents double submission in same tab)
const activeVerifications = new Map();

/**
 * Get RPC Provider with Failover and Timeout
 */
async function getProvider() {
    let lastError = null;
    
    for (const rpcUrl of WALLET_CONFIG.RPC_ENDPOINTS) {
        try {
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            provider.timeout = WALLET_CONFIG.RPC_TIMEOUT;
            
            // Test the connection with timeout
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

/**
 * Acquire processing lock using atomic runTransaction
 * This prevents race conditions when multiple requests try to lock simultaneously
 */
async function acquireProcessingLock(txHash, uid, amount) {
    const lockRef = ref(db, `processingTransactions/${txHash}`);
    
    try {
        // Use runTransaction for atomic lock acquisition
        const result = await runTransaction(lockRef, (currentData) => {
            // If lock exists, check if it's stale
            if (currentData !== null) {
                const now = Date.now();
                const lockTime = currentData.timestamp || 0;
                
                // If lock is older than STALE_LOCK_TIMEOUT, consider it stale and take over
                if (now - lockTime > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                    return {
                        uid: uid,
                        timestamp: now,
                        status: 'processing',
                        amount: amount
                    };
                }
                
                // Lock is valid, don't allow takeover
                return;
            }
            
            // No lock exists, create one
            return {
                uid: uid,
                timestamp: Date.now(),
                status: 'processing',
                amount: amount
            };
        });
        
        if (result.committed) {
            // Lock was acquired successfully
            return true;
        }
        
        // Lock was not acquired (already exists and not stale)
        return false;
        
    } catch (error) {
        console.error('Error acquiring processing lock:', error);
        return false;
    }
}

/**
 * Release processing lock
 */
async function releaseProcessingLock(txHash) {
    try {
        const lockRef = ref(db, `processingTransactions/${txHash}`);
        await remove(lockRef);
        return true;
    } catch (error) {
        console.error('Error releasing processing lock:', error);
        return false;
    }
}

/**
 * Check if transaction hash already used (FAST lookup using usedTransactions node)
 */
export async function checkDuplicateTransaction(txHash) {
    try {
        // Direct lookup in usedTransactions node
        const snap = await get(ref(db, `usedTransactions/${txHash}`));
        if (snap.exists()) {
            return {
                isDuplicate: true,
                data: snap.val()
            };
        }
        return { isDuplicate: false };
    } catch (error) {
        console.error("Error checking duplicate:", error);
        throw new Error("Failed to check transaction status");
    }
}

/**
 * Verify USDT Transfer on Blockchain
 */
export async function verifyTransaction(txHash, expectedAmount) {
    // Check if this hash is already being verified in this browser tab
    if (activeVerifications.has(txHash)) {
        return {
            success: false,
            error: "This transaction is already being verified. Please wait."
        };
    }
    
    // Lock this hash in memory
    activeVerifications.set(txHash, Date.now());
    
    try {
        // Get provider with failover
        const provider = await getProvider();
        
        // Get transaction receipt with retry
        let receipt = null;
        let retries = 3;
        while (retries > 0 && !receipt) {
            try {
                receipt = await provider.getTransactionReceipt(txHash);
                if (!receipt) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    retries--;
                } else {
                    break;
                }
            } catch (e) {
                retries--;
                if (retries === 0) throw e;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        if (!receipt) {
            return {
                success: false,
                error: "Transaction not found. Please check the hash and try again."
            };
        }
        
        // Check transaction status
        if (receipt.status !== 1) {
            return {
                success: false,
                error: "Transaction failed on blockchain. Please check the transaction."
            };
        }
        
        // Check confirmations
        const currentBlock = await provider.getBlockNumber();
        const confirmations = currentBlock - receipt.blockNumber;
        
        if (confirmations < WALLET_CONFIG.MIN_CONFIRMATIONS) {
            return {
                success: false,
                error: `Waiting for confirmations... (${confirmations}/${WALLET_CONFIG.MIN_CONFIRMATIONS})`,
                pending: true,
                confirmations: confirmations,
                currentBlock: currentBlock,
                blockNumber: receipt.blockNumber
            };
        }
        
        // Parse transaction logs for USDT transfer
        const iface = new ethers.Interface(ERC20_ABI);
        let transferEvent = null;
        let fromAddress = null;
        let toAddress = null;
        let transferAmount = null;
        let tokenContract = null;
        
        // Find USDT transfer in logs - CORRECT: Loop through all logs and check contract
        for (const log of receipt.logs) {
            // Check if this log is from USDT contract
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
                // Skip non-ERC20 logs
                continue;
            }
        }
        
        if (!transferEvent) {
            return {
                success: false,
                error: "No USDT transfer found in this transaction. Please verify the contract address."
            };
        }
        
        // Verify token contract
        if (tokenContract?.toLowerCase() !== WALLET_CONFIG.USDT_CONTRACT.toLowerCase()) {
            return {
                success: false,
                error: `Invalid token. Expected USDT (${WALLET_CONFIG.USDT_CONTRACT}) but got ${tokenContract || 'unknown'}.`
            };
        }
        
        // Verify receiver wallet
        if (toAddress?.toLowerCase() !== WALLET_CONFIG.DEPOSIT_WALLET.toLowerCase()) {
            return {
                success: false,
                error: `Wrong receiver wallet. Expected ${WALLET_CONFIG.DEPOSIT_WALLET} but got ${toAddress}.`
            };
        }
        
        // Convert amount to human readable (USDT has 18 decimals)
        const amountInUSDT = parseFloat(ethers.formatUnits(transferAmount, 18));
        const expectedAmountNum = parseFloat(expectedAmount);
        
        // Check amount with small tolerance for rounding
        const tolerance = 0.001;
        if (Math.abs(amountInUSDT - expectedAmountNum) > tolerance) {
            return {
                success: false,
                error: `Amount mismatch. Expected ${expectedAmountNum} USDT but received ${amountInUSDT.toFixed(2)} USDT.`
            };
        }
        
        // All verifications passed
        return {
            success: true,
            verified: true,
            receipt: {
                blockNumber: receipt.blockNumber,
                confirmations: confirmations,
                from: fromAddress,
                to: toAddress,
                amount: amountInUSDT,
                tokenContract: tokenContract,
                txHash: txHash,
                blockHash: receipt.blockHash,
                gasUsed: receipt.gasUsed.toString(),
                status: receipt.status
            }
        };
        
    } catch (error) {
        console.error("Verification error:", error);
        return {
            success: false,
            error: `Verification failed: ${error.message}`
        };
    } finally {
        // Remove from active verifications
        activeVerifications.delete(txHash);
    }
}

/**
 * Process deposit with atomic transaction and safe balance read
 */
export async function processDeposit(uid, txHash, amount, receipt) {
    try {
        // Use runTransaction for atomic operation on user data
        const result = await runTransaction(ref(db, `users/${uid}`), (currentData) => {
            if (currentData === null) {
                return { error: "User not found" };
            }
            
            // Update deposit wallet
            const currentBalance = currentData.depositWallet || 0;
            currentData.depositWallet = currentBalance + amount;
            
            return currentData;
        });
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        // Safely get the updated balance
        const balanceSnap = await get(ref(db, `users/${uid}/depositWallet`));
        const newBalance = balanceSnap.exists() ? balanceSnap.val() : (result.data?.depositWallet || 0);
        
        // Create transaction record using push (no overwrite)
        const transactionsRef = ref(db, `users/${uid}/transactions`);
        const newTxRef = push(transactionsRef);
        await set(newTxRef, {
            type: 'deposit',
            status: 'success',
            amount: amount,
            txHash: txHash,
            blockNumber: receipt.blockNumber,
            from: receipt.from,
            to: receipt.to,
            tokenContract: receipt.tokenContract,
            confirmations: receipt.confirmations,
            timestamp: Date.now(),
            description: `Deposit of $${amount} USDT verified on blockchain`
        });
        
        // Mark transaction as used (for fast duplicate check)
        await set(ref(db, `usedTransactions/${txHash}`), {
            uid: uid,
            amount: amount,
            timestamp: Date.now(),
            blockNumber: receipt.blockNumber
        });
        
        return {
            success: true,
            newBalance: newBalance
        };
        
    } catch (error) {
        console.error("Error processing deposit:", error);
        throw error;
    }
}

/**
 * Complete deposit flow with all checks and auto-polling
 */
export async function completeDeposit(uid, txHash, amount, onPending, onSuccess, onError) {
    // Step 1: Acquire processing lock using atomic runTransaction
    const lockAcquired = await acquireProcessingLock(txHash, uid, amount);
    if (!lockAcquired) {
        return {
            success: false,
            error: "This transaction is already being processed. Please wait."
        };
    }
    
    try {
        // Step 2: Check duplicate
        const duplicateCheck = await checkDuplicateTransaction(txHash);
        if (duplicateCheck.isDuplicate) {
            await releaseProcessingLock(txHash);
            return {
                success: false,
                error: "This transaction hash has already been used. Duplicate deposits are not allowed."
            };
        }
        
        // Step 3: Verify on blockchain
        const verification = await verifyTransaction(txHash, amount);
        
        // If pending, start auto-polling
        if (verification.pending) {
            if (onPending) {
                onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
            }
            
            // Start auto-polling
            const pollingResult = await startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError);
            
            // Release lock after polling completes or fails
            await releaseProcessingLock(txHash);
            return pollingResult;
        }
        
        if (!verification.success) {
            await releaseProcessingLock(txHash);
            return verification;
        }
        
        // Step 4: Process deposit with atomic transaction
        try {
            const result = await processDeposit(uid, txHash, amount, verification.receipt);
            await releaseProcessingLock(txHash);
            
            if (onSuccess) {
                onSuccess(result.newBalance);
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
        console.error('Complete deposit error:', error);
        return {
            success: false,
            error: error.message || "Failed to complete deposit"
        };
    }
}

/**
 * Auto-polling for pending transactions
 */
async function startAutoPolling(uid, txHash, amount, onPending, onSuccess, onError) {
    let attempts = 0;
    
    return new Promise((resolve) => {
        const pollInterval = setInterval(async () => {
            attempts++;
            
            try {
                // Check if transaction is still being processed
                const lockSnap = await get(ref(db, `processingTransactions/${txHash}`));
                if (!lockSnap.exists()) {
                    clearInterval(pollInterval);
                    resolve({
                        success: false,
                        error: "Processing was interrupted. Please try again."
                    });
                    return;
                }
                
                // Re-verify
                const verification = await verifyTransaction(txHash, amount);
                
                if (verification.pending) {
                    // Still pending, update status
                    if (onPending) {
                        onPending(verification.confirmations, verification.currentBlock, verification.blockNumber);
                    }
                    
                    if (attempts >= WALLET_CONFIG.MAX_POLLING_ATTEMPTS) {
                        clearInterval(pollInterval);
                        resolve({
                            success: false,
                            error: `Still waiting for confirmations after ${attempts * WALLET_CONFIG.POLLING_INTERVAL / 1000} seconds. Please try again later.`,
                            pending: true,
                            confirmations: verification.confirmations
                        });
                    }
                    return;
                }
                
                // Verification completed (success or error)
                clearInterval(pollInterval);
                
                if (!verification.success) {
                    resolve(verification);
                    return;
                }
                
                // Process deposit
                try {
                    const result = await processDeposit(uid, txHash, amount, verification.receipt);
                    if (onSuccess) {
                        onSuccess(result.newBalance);
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

/**
 * Clean up stale processing locks (run on page load)
 */
export async function cleanupStaleLocks() {
    try {
        const locksSnap = await get(ref(db, 'processingTransactions'));
        if (!locksSnap.exists()) return;
        
        const locks = locksSnap.val();
        const now = Date.now();
        
        for (const [txHash, lockData] of Object.entries(locks)) {
            if (now - lockData.timestamp > WALLET_CONFIG.STALE_LOCK_TIMEOUT) {
                await remove(ref(db, `processingTransactions/${txHash}`));
                console.log(`Cleaned up stale lock for ${txHash}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up stale locks:', error);
    }
}

/**
 * Check and continue pending verification on page load
 */
export async function checkPendingVerifications(uid) {
    try {
        const locksSnap = await get(ref(db, 'processingTransactions'));
        if (!locksSnap.exists()) return [];
        
        const locks = locksSnap.val();
        const pendingTxs = [];
        
        for (const [txHash, lockData] of Object.entries(locks)) {
            if (lockData.uid === uid) {
                // Check if this transaction was already processed
                const usedSnap = await get(ref(db, `usedTransactions/${txHash}`));
                if (usedSnap.exists()) {
                    // Already processed, clean up lock
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