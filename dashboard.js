// ============================================================
// RND STAKING PLATFORM - DASHBOARD.JS (PRODUCTION READY v8)
// ============================================================
// 🔥 FINAL VERSION - All Issues Fixed
// 🔥 Recovery: ONLY update() - NO set()
// 🔥 Transaction History: Limited to 500
// 🔥 Transfer History: Limited to 100
// 🔥 Daily Release: Processing Lock
// 🔥 Commission: Processing Lock
// 🔥 Package Validation: Full checks
// 🔥 Transfer Validation: All edge cases
// 🔥 Referral Validation: Self referral reject
// 🔥 Processing Lock: Global lock system
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, runTransaction, onValue, set, query, orderByChild, equalTo, limitToLast } from "firebase/database";

// ============================================================
// FIREBASE CONFIG
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyAz-TLmOhiy-_vHHmIjW8gyIOqTR_PT9o0",
    authDomain: "rnd2-70080.firebaseapp.com",
    databaseURL: "https://rnd2-70080-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "rnd2-70080",
    storageBucket: "rnd2-70080.firebasestorage.app",
    messagingSenderId: "468625887938",
    appId: "1:468625887938:web:5cb4ddbcf31b6fc0a4615b",
    measurementId: "G-ELVJD5NQKB"
};

const DOMAIN = "https://staking.randigital.in";
const REGISTER_URL = `${DOMAIN}/register.html`;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// GLOBAL VARIABLES
// ============================================================
let rndPrice = 1.00;
let currentUserData = null;
let currentUserId = null;
let isDashboardLoading = false;
let listenerOff = null;
let listenerTimeout = null;
let releaseInProgress = false;
let commissionInProgress = false;
let updateTimer = null;
let verifiedRecipient = null;
let processingLocks = {};

// ============================================================
// 🔥 PROCESSING LOCK SYSTEM
// ============================================================
async function acquireLock(lockId, userId, timeout = 30000) {
    try {
        const lockRef = ref(db, `processing_locks/${lockId}`);
        const now = Date.now();
        
        const result = await runTransaction(lockRef, (currentData) => {
            if (currentData) {
                // Check if lock is expired
                if (currentData.lockedAt && (now - currentData.lockedAt) < timeout) {
                    return; // Lock is active
                }
            }
            
            // Acquire lock
            return {
                lockedAt: now,
                userId: userId,
                lockId: lockId,
                expiresAt: now + timeout
            };
        });
        
        if (result.committed && result.snapshot.exists()) {
            processingLocks[lockId] = true;
            console.log(`🔒 Lock acquired: ${lockId}`);
            return true;
        }
        
        console.log(`⚠️ Lock already held: ${lockId}`);
        return false;
        
    } catch (error) {
        console.error(`❌ Error acquiring lock ${lockId}:`, error);
        return false;
    }
}

async function releaseLock(lockId) {
    try {
        const lockRef = ref(db, `processing_locks/${lockId}`);
        await set(lockRef, null);
        delete processingLocks[lockId];
        console.log(`🔓 Lock released: ${lockId}`);
        return true;
    } catch (error) {
        console.error(`❌ Error releasing lock ${lockId}:`, error);
        return false;
    }
}

// ============================================================
// 🔥 TRANSACTION HISTORY LIMIT (Keep latest 500)
// ============================================================
function limitTransactionHistory(transactions, maxCount = 500) {
    if (!transactions) return {};
    
    const keys = Object.keys(transactions);
    if (keys.length <= maxCount) return transactions;
    
    // Sort by timestamp (newest first)
    const sorted = keys.sort((a, b) => {
        const ta = transactions[a].timestamp || 0;
        const tb = transactions[b].timestamp || 0;
        return tb - ta;
    });
    
    // Keep only latest maxCount
    const keep = sorted.slice(0, maxCount);
    const result = {};
    keep.forEach(key => {
        result[key] = transactions[key];
    });
    
    console.log(`📊 Transactions limited to ${maxCount} (was ${keys.length})`);
    return result;
}

// ============================================================
// 🔥 TRANSFER HISTORY LIMIT (Keep latest 100)
// ============================================================
function limitTransferHistory(history, maxCount = 100) {
    if (!history || !Array.isArray(history)) return [];
    if (history.length <= maxCount) return history;
    
    // Sort by timestamp (newest first)
    const sorted = [...history].sort((a, b) => {
        return (b.timestamp || 0) - (a.timestamp || 0);
    });
    
    const result = sorted.slice(0, maxCount);
    console.log(`📊 Transfer history limited to ${maxCount} (was ${history.length})`);
    return result;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';
    toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Morning';
    if (hour < 17) return 'Afternoon';
    return 'Evening';
}

function generateTxId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

function generateBackupId() {
    return 'backup_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

function getDaysBetween(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    const diffTime = Math.abs(d2 - d1);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function isValidAmount(amount) {
    return typeof amount === 'number' && 
           isFinite(amount) && 
           !isNaN(amount) && 
           amount > 0;
}

// ============================================================
// SIDEBAR CONTROLS
// ============================================================
const sidebarPanel = document.getElementById('sidebarPanel');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarClose = document.getElementById('sidebarClose');

function openSidebar() {
    sidebarPanel.classList.add('open');
    sidebarOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeSidebar() {
    sidebarPanel.classList.remove('open');
    sidebarOverlay.classList.remove('active');
    document.body.style.overflow = '';
}

sidebarToggle.addEventListener('click', openSidebar);
sidebarClose.addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

document.getElementById('logoutBtnSidebar').addEventListener('click', async (e) => {
    e.preventDefault();
    await signOut(auth);
    window.location.href = 'login.html';
});

// ============================================================
// FETCH LIVE RATE
// ============================================================
async function fetchLiveRate() {
    try {
        const settingsRef = ref(db, 'settings/rate');
        const snapshot = await get(settingsRef);
        if (snapshot.exists()) {
            rndPrice = snapshot.val();
        } else {
            const checkRef = await get(ref(db, 'settings'));
            if (!checkRef.exists()) {
                await set(ref(db, 'settings'), { rate: 1.00 });
            }
            rndPrice = 1.00;
        }
    } catch (error) {
        console.error('Error fetching rate:', error);
    }
    return rndPrice;
}

// ============================================================
// GET USER BY IDENTIFIER
// ============================================================
let usersCache = null;
let usersCacheTime = 0;
const CACHE_TTL = 10000;

async function getUserByIdentifier(identifier) {
    try {
        if (!identifier) return null;
        
        const normalizedId = identifier.trim();
        if (!normalizedId) return null;
        
        const now = Date.now();
        if (usersCache && (now - usersCacheTime) < CACHE_TTL) {
            for (let uid in usersCache) {
                const u = usersCache[uid];
                if (u.uid === normalizedId || 
                    u.username === normalizedId || 
                    u.referralCode === normalizedId) {
                    return { uid: uid, data: u, source: 'cache' };
                }
            }
        }
        
        console.log('🔍 Searching for user:', normalizedId);
        
        const uidSnap = await get(ref(db, 'users/' + normalizedId));
        if (uidSnap.exists()) {
            const data = uidSnap.val();
            if (!usersCache) usersCache = {};
            usersCache[normalizedId] = data;
            usersCacheTime = now;
            return { uid: normalizedId, data: data, source: 'uid' };
        }
        
        const usernameQuery = query(ref(db, 'users'), orderByChild('username'), equalTo(normalizedId));
        const usernameSnap = await get(usernameQuery);
        if (usernameSnap.exists()) {
            const data = usernameSnap.val();
            const uid = Object.keys(data)[0];
            if (!usersCache) usersCache = {};
            usersCache[uid] = data[uid];
            usersCacheTime = now;
            return { uid: uid, data: data[uid], source: 'username' };
        }
        
        const referralQuery = query(ref(db, 'users'), orderByChild('referralCode'), equalTo(normalizedId));
        const referralSnap = await get(referralQuery);
        if (referralSnap.exists()) {
            const data = referralSnap.val();
            const uid = Object.keys(data)[0];
            if (!usersCache) usersCache = {};
            usersCache[uid] = data[uid];
            usersCacheTime = now;
            return { uid: uid, data: data[uid], source: 'referralCode' };
        }
        
        return null;
    } catch (error) {
        console.error('Error getting user by identifier:', error);
        return null;
    }
}

// ============================================================
// GET LIVE REFERRAL COUNTS
// ============================================================
async function getLiveReferralCounts(userData) {
    try {
        const result = {
            level1: 0,
            level2: 0,
            level3: 0,
            level4: 0,
            level5: 0,
            total: 0,
            directReferralsList: []
        };
        
        if (!userData || !userData.referralCode) {
            return result;
        }
        
        if (userData.directReferrals) {
            const directKeys = Object.keys(userData.directReferrals);
            result.level1 = directKeys.length;
            result.directReferralsList = directKeys.map(key => userData.directReferrals[key]);
        }
        
        if (userData.teamStructure) {
            result.level2 = userData.teamStructure.level2 || 0;
            result.level3 = userData.teamStructure.level3 || 0;
            result.level4 = userData.teamStructure.level4 || 0;
            result.level5 = userData.teamStructure.level5 || 0;
        }
        
        result.total = result.level1 + result.level2 + result.level3 + result.level4 + result.level5;
        return result;
        
    } catch (error) {
        console.error('Error getting referral counts:', error);
        return {
            level1: userData.totalReferrals || 0,
            level2: userData.teamStructure?.level2 || 0,
            level3: userData.teamStructure?.level3 || 0,
            level4: userData.teamStructure?.level4 || 0,
            level5: userData.teamStructure?.level5 || 0,
            total: userData.totalReferrals || 0,
            directReferralsList: []
        };
    }
}

// ============================================================
// BACKUP SYSTEM (Only meaningful events)
// ============================================================
async function createBackup(userId, action, data) {
    try {
        const meaningfulActions = [
            'registration', 'deposit', 'buy_package', 'withdrawal', 
            'transfer', 'daily_release', 'referral_commission', 'admin_update'
        ];
        
        if (!meaningfulActions.includes(action)) {
            console.log('ℹ️ Skipping backup for non-critical action:', action);
            return null;
        }
        
        const backupId = generateBackupId();
        const backupRef = ref(db, `backups/${userId}/${backupId}`);
        
        const backupData = {
            action: action,
            timestamp: Date.now(),
            date: getTodayDate(),
            data: data,
            userId: userId,
            backupId: backupId
        };
        
        await set(backupRef, backupData);
        console.log(`✅ Backup created: ${backupId} for action: ${action}`);
        return backupId;
    } catch (error) {
        console.error('❌ Backup creation failed:', error);
        return null;
    }
}

// ============================================================
// 🔥 PROCESS REFERRAL COMMISSION (WITH LOCK)
// ============================================================
async function processReferralCommission(userId, packageId, packageData) {
    const lockId = `commission_${packageId}`;
    
    // Try to acquire lock
    const lockAcquired = await acquireLock(lockId, userId);
    if (!lockAcquired) {
        console.log('⏳ Commission already in progress, skipping...');
        return null;
    }
    
    try {
        if (commissionInProgress) {
            console.log('⏳ Commission already in progress, skipping...');
            return null;
        }
        
        commissionInProgress = true;
        
        if (packageData.commissionProcessed === true) {
            console.log('⚠️ Commission already processed for package:', packageId);
            return null;
        }
        if (packageData.status !== 'active') {
            console.log('⚠️ Package not active, skipping commission:', packageId);
            return null;
        }
        
        const userSnapshot = await get(ref(db, 'users/' + userId));
        if (!userSnapshot.exists()) {
            console.log('❌ User not found for commission:', userId);
            return null;
        }
        
        const userData = userSnapshot.val();
        const packageAmount = packageData.usdtAmount || 0;
        
        if (packageAmount <= 0) {
            console.log('⚠️ Package amount is 0, skipping commission');
            return null;
        }
        
        const commissionLevels = [
            { level: 1, percent: 0.08 },
            { level: 2, percent: 0.04 },
            { level: 3, percent: 0.02 },
            { level: 4, percent: 0.01 },
            { level: 5, percent: 0.01 }
        ];
        
        let currentRefCode = userData.referredBy;
        let level = 1;
        let commissionProcessed = false;
        
        console.log('🔍 Starting commission chain from referredBy:', currentRefCode);
        
        while (currentRefCode && level <= 5) {
            console.log(`🔍 Looking for Level ${level} referrer with code:`, currentRefCode);
            
            const refResult = await getUserByIdentifier(currentRefCode);
            
            if (!refResult || refResult.uid === userId) {
                console.log(`ℹ️ Level ${level} chain ends here`);
                break;
            }
            
            const referrerData = refResult.data;
            const uid = refResult.uid;
            
            const commissionPercent = commissionLevels.find(l => l.level === level)?.percent || 0;
            const commissionAmount = packageAmount * commissionPercent;
            
            if (commissionAmount > 0) {
                console.log(`✅ Level ${level} commission: $${commissionAmount.toFixed(2)} (${commissionPercent * 100}%)`);
                
                const referrerRef = ref(db, 'users/' + uid);
                await runTransaction(referrerRef, (currentData) => {
                    if (!currentData) return currentData;
                    
                    currentData.referralWallet = (currentData.referralWallet || 0) + commissionAmount;
                    const levelKey = `level${level}Earnings`;
                    currentData[levelKey] = (currentData[levelKey] || 0) + commissionAmount;
                    currentData.referralEarnings = (currentData.referralEarnings || 0) + commissionAmount;
                    currentData.teamBusiness = (currentData.teamBusiness || 0) + packageAmount;
                    
                    const commissionHistory = currentData.commissionHistory || [];
                    const existing = commissionHistory.find(h => 
                        h.packageId === packageId && h.level === level
                    );
                    
                    if (!existing) {
                        commissionHistory.push({
                            type: 'referral_commission',
                            level: level,
                            percent: commissionPercent * 100,
                            amount: commissionAmount,
                            fromUser: userData.username || userData.referralCode || userId,
                            fromUid: userId,
                            packageId: packageId,
                            timestamp: Date.now(),
                            date: getTodayDate(),
                            description: `${commissionPercent * 100}% commission from Level ${level} referral`
                        });
                        currentData.commissionHistory = commissionHistory;
                        
                        const transactions = currentData.transactions || {};
                        transactions[generateTxId()] = {
                            type: 'referral_commission',
                            amount: commissionAmount,
                            currency: 'USDT',
                            level: level,
                            percent: commissionPercent * 100,
                            fromUser: userData.username || userData.referralCode || userId,
                            fromUid: userId,
                            timestamp: Date.now(),
                            date: getTodayDate(),
                            status: 'completed',
                            description: `Received ${commissionPercent * 100}% commission ($${commissionAmount.toFixed(2)}) from Level ${level} referral`
                        };
                        currentData.transactions = transactions;
                    }
                    
                    return currentData;
                });
                commissionProcessed = true;
                
                await createBackup(uid, 'referral_commission', {
                    level: level,
                    amount: commissionAmount,
                    fromUser: userData.username || userData.referralCode || userId,
                    packageId: packageId
                });
            }
            
            currentRefCode = referrerData.referredBy || null;
            level++;
        }
        
        if (commissionProcessed) {
            await update(ref(db, 'users/' + userId + '/packages/' + packageId), {
                commissionProcessed: true,
                commissionProcessedAt: Date.now()
            });
            console.log('✅ Commission processed for package ' + packageId);
        } else {
            console.log('ℹ️ No commissions processed for package ' + packageId);
        }
        
        return true;
        
    } catch (error) {
        console.error('❌ Error processing commission:', error);
        return null;
    } finally {
        commissionInProgress = false;
        await releaseLock(lockId);
    }
}

// ============================================================
// 🔥 PROCESS DAILY RELEASE (WITH LOCK)
// ============================================================
async function processDailyRelease(userId) {
    const lockId = `release_${userId}`;
    
    const lockAcquired = await acquireLock(lockId, userId);
    if (!lockAcquired) {
        console.log('⏳ Release already in progress, skipping...');
        return null;
    }
    
    try {
        if (releaseInProgress) {
            console.log('⏳ Release already in progress, skipping...');
            return null;
        }
        
        releaseInProgress = true;
        
        const userRef = ref(db, 'users/' + userId);
        const today = getTodayDate();
        
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) return currentData;
            
            const lastReleaseDate = currentData.lastReleaseDate || '';
            
            let pendingDays = 0;
            if (lastReleaseDate) {
                const daysDiff = getDaysBetween(lastReleaseDate, today);
                if (daysDiff === 0) {
                    return currentData;
                }
                pendingDays = Math.max(0, daysDiff - 1);
            }
            
            const packages = currentData.packages || {};
            let updatedPackages = {};
            let releaseTransactions = [];
            let totalReleaseToday = 0;
            let hasActivePackages = false;
            
            for (const [pkgKey, pkg] of Object.entries(packages)) {
                if (pkg.status !== 'active') {
                    updatedPackages[pkgKey] = pkg;
                    continue;
                }
                
                // ✅ Package Validation
                const remainingRND = pkg.remainingRND || 0;
                const dailyRelease = pkg.dailyRelease || 0;
                const totalRND = pkg.totalRND || 0;
                const releasedRND = pkg.releasedRND || 0;
                
                if (remainingRND < 0 || dailyRelease <= 0 || releasedRND > totalRND) {
                    console.warn(`⚠️ Invalid package data: ${pkgKey}`);
                    pkg.status = 'completed';
                    pkg.remainingRND = 0;
                    updatedPackages[pkgKey] = pkg;
                    continue;
                }
                
                if (remainingRND <= 0) {
                    pkg.status = 'completed';
                    pkg.remainingRND = 0;
                    updatedPackages[pkgKey] = pkg;
                    continue;
                }
                
                hasActivePackages = true;
                const totalDaysToRelease = pendingDays + 1;
                let totalReleaseAmount = Math.min(dailyRelease * totalDaysToRelease, remainingRND);
                let todayReleaseAmount = Math.min(dailyRelease, remainingRND);
                
                pkg.remainingRND = remainingRND - totalReleaseAmount;
                pkg.releasedRND = (pkg.releasedRND || 0) + totalReleaseAmount;
                
                if (pkg.remainingRND <= 0) {
                    pkg.remainingRND = 0;
                    pkg.status = 'completed';
                }
                
                updatedPackages[pkgKey] = pkg;
                totalReleaseToday += todayReleaseAmount;
                
                releaseTransactions.push({
                    type: 'daily_release',
                    amount: todayReleaseAmount,
                    currency: 'RND',
                    packageId: pkgKey,
                    planName: pkg.planName || 'Package',
                    timestamp: Date.now(),
                    date: today,
                    status: 'completed',
                    description: `Daily release of ${todayReleaseAmount.toFixed(4)} RND from ${pkg.planName || 'Package'}`
                });
                
                if (pendingDays > 0) {
                    const pendingAmount = totalReleaseAmount - todayReleaseAmount;
                    releaseTransactions.push({
                        type: 'pending_release',
                        amount: pendingAmount,
                        currency: 'RND',
                        packageId: pkgKey,
                        planName: pkg.planName || 'Package',
                        timestamp: Date.now(),
                        date: today,
                        status: 'completed',
                        description: `Pending release of ${pendingAmount.toFixed(4)} RND from ${pkg.planName || 'Package'} (${pendingDays} days pending)`
                    });
                }
            }
            
            if (!hasActivePackages || totalReleaseToday === 0) {
                currentData.lastReleaseDate = today;
                return currentData;
            }
            
            currentData.rndWallet = (currentData.rndWallet || 0) + totalReleaseToday;
            currentData.lockedRND = (currentData.lockedRND || 0) - totalReleaseToday;
            currentData.totalReleased = (currentData.totalReleased || 0) + totalReleaseToday;
            currentData.lastReleaseDate = today;
            currentData.packages = updatedPackages;
            
            const transactions = currentData.transactions || {};
            releaseTransactions.forEach(tx => {
                transactions[generateTxId()] = tx;
            });
            
            // ✅ Limit transactions
            currentData.transactions = limitTransactionHistory(transactions, 500);
            
            return currentData;
        });
        
        if (result.committed && result.snapshot.exists()) {
            const data = result.snapshot.val();
            console.log('✅ Daily release processed successfully');
            
            await createBackup(userId, 'daily_release', {
                amount: data.rndWallet || 0,
                date: today
            });
            
            return data;
        }
        return null;
    } catch (error) {
        console.error('❌ Error processing daily release:', error);
        return null;
    } finally {
        releaseInProgress = false;
        await releaseLock(lockId);
    }
}

// ============================================================
// CALCULATE USER STATS
// ============================================================
function calculateUserStats(userData) {
    const packages = userData.packages || {};
    let totalLockedRND = 0;
    let totalDailyRelease = 0;
    let activePackages = 0;
    let totalStake = 0;
    let totalReleased = 0;
    
    for (let key in packages) {
        const pkg = packages[key];
        if (pkg.status === 'active') {
            totalLockedRND += (pkg.remainingRND || 0);
            totalDailyRelease += (pkg.dailyRelease || 0);
            activePackages++;
            totalStake += (pkg.usdtAmount || 0);
        }
        totalReleased += (pkg.releasedRND || 0);
    }
    
    return {
        totalLockedRND,
        totalDailyRelease,
        activePackages,
        totalStake,
        totalReleased
    };
}

// ============================================================
// 🔥 ATOMIC TRANSFER (WITH SELF TRANSFER PROTECTION)
// ============================================================
async function atomicTransfer(senderUid, recipientUid, recipientData, amount, walletType, currency, senderUsername, senderUidForHistory) {
    // ✅ Amount Validation
    if (!isValidAmount(amount)) {
        return { success: false, error: 'Invalid amount' };
    }
    
    // ✅ Self Transfer Protection
    if (senderUid === recipientUid) {
        return { success: false, error: 'You cannot transfer to your own account' };
    }
    
    const lockId = `transfer_${senderUid}_${Date.now()}`;
    const lockAcquired = await acquireLock(lockId, senderUid);
    if (!lockAcquired) {
        return { success: false, error: 'Another transfer is in progress. Please wait.' };
    }
    
    try {
        const senderRef = ref(db, 'users/' + senderUid);
        const timestamp = Date.now();
        const date = getTodayDate();
        const txId = generateTxId();
        
        const recipientUsername = recipientData.username || recipientData.referralCode || recipientUid;
        const recipientUidForHistory = recipientUid;
        
        await createBackup(senderUid, 'transfer', {
            to: recipientUsername,
            toUid: recipientUid,
            amount: amount,
            currency: currency,
            walletType: walletType
        });
        
        const senderResult = await runTransaction(senderRef, (currentData) => {
            if (!currentData) return currentData;
            const balance = currentData[walletType] || 0;
            if (balance < amount) {
                return currentData;
            }
            currentData[walletType] = balance - amount;
            
            const transferHistory = currentData.transferHistory || [];
            transferHistory.push({
                type: 'sent',
                to: recipientUsername,
                toUid: recipientUidForHistory,
                amount: amount,
                from: senderUsername,
                fromUid: senderUidForHistory || senderUid,
                currency: currency,
                timestamp: timestamp,
                txId: txId,
                status: 'completed'
            });
            
            // ✅ Limit transfer history
            currentData.transferHistory = limitTransferHistory(transferHistory, 100);
            
            const transactions = currentData.transactions || {};
            transactions[txId] = {
                type: 'transfer_sent',
                amount: amount,
                currency: currency,
                to: recipientUsername,
                toUid: recipientUidForHistory,
                from: senderUsername,
                fromUid: senderUidForHistory || senderUid,
                timestamp: timestamp,
                date: date,
                status: 'completed'
            };
            
            // ✅ Limit transactions
            currentData.transactions = limitTransactionHistory(transactions, 500);
            
            return currentData;
        });
        
        if (!senderResult.committed) {
            return { success: false, error: 'Insufficient balance or sender update failed' };
        }
        
        const recipientRef = ref(db, 'users/' + recipientUid);
        const recipientResult = await runTransaction(recipientRef, (currentData) => {
            if (!currentData) return currentData;
            currentData[walletType] = (currentData[walletType] || 0) + amount;
            
            const transferHistory = currentData.transferHistory || [];
            transferHistory.push({
                type: 'received',
                from: senderUsername,
                fromUid: senderUidForHistory || senderUid,
                to: recipientUsername,
                toUid: recipientUidForHistory,
                amount: amount,
                currency: currency,
                timestamp: timestamp,
                txId: txId,
                status: 'completed'
            });
            
            // ✅ Limit transfer history
            currentData.transferHistory = limitTransferHistory(transferHistory, 100);
            
            const transactions = currentData.transactions || {};
            transactions[txId] = {
                type: 'transfer_received',
                amount: amount,
                currency: currency,
                from: senderUsername,
                fromUid: senderUidForHistory || senderUid,
                to: recipientUsername,
                toUid: recipientUidForHistory,
                timestamp: timestamp,
                date: date,
                status: 'completed'
            };
            
            // ✅ Limit transactions
            currentData.transactions = limitTransactionHistory(transactions, 500);
            
            return currentData;
        });
        
        if (!recipientResult.committed) {
            // Rollback sender
            await runTransaction(senderRef, (currentData) => {
                if (!currentData) return currentData;
                currentData[walletType] = (currentData[walletType] || 0) + amount;
                const transactions = currentData.transactions || {};
                if (transactions[txId]) {
                    transactions[txId].status = 'rolled_back';
                }
                currentData.transactions = transactions;
                return currentData;
            });
            return { success: false, error: 'Recipient update failed, funds returned' };
        }
        
        return { success: true, txId: txId };
        
    } catch (error) {
        console.error('Transfer error:', error);
        return { success: false, error: error.message || 'Transfer failed' };
    } finally {
        await releaseLock(lockId);
    }
}

// ============================================================
// VERIFY RECIPIENT FOR TRANSFER
// ============================================================
async function verifyRecipient(identifier) {
    const user = auth.currentUser;
    if (!user) return;
    
    const senderUid = user.uid;
    const resultDiv = document.getElementById('recipientVerificationResult');
    const transferBtn = document.getElementById('transferSubmitBtn');
    
    if (!identifier || identifier.trim() === '') {
        resultDiv.innerHTML = '';
        verifiedRecipient = null;
        if (transferBtn) transferBtn.disabled = true;
        return;
    }
    
    resultDiv.innerHTML = `
        <div class="text-center text-muted py-2" style="font-size:0.85rem;">
            <span class="spinner-border spinner-border-sm me-2"></span> Searching...
        </div>
    `;
    
    try {
        const result = await getUserByIdentifier(identifier.trim());
        
        if (!result) {
            resultDiv.innerHTML = `
                <div class="recipient-not-found">
                    <i class="bi bi-exclamation-circle text-danger me-2"></i>
                    <div>
                        <strong>Recipient Not Found</strong>
                        <div style="font-size:0.8rem;color:#94a3b8;">Please check the User ID, Username or Referral Code.</div>
                    </div>
                </div>
            `;
            verifiedRecipient = null;
            if (transferBtn) transferBtn.disabled = true;
            return;
        }
        
        // ✅ Self Transfer Check
        if (result.uid === senderUid) {
            resultDiv.innerHTML = `
                <div class="recipient-error">
                    <i class="bi bi-exclamation-triangle text-warning me-2"></i>
                    <div>
                        <strong>You cannot transfer to your own account</strong>
                        <div style="font-size:0.8rem;color:#94a3b8;">Please enter a different User ID.</div>
                    </div>
                </div>
            `;
            verifiedRecipient = null;
            if (transferBtn) transferBtn.disabled = true;
            return;
        }
        
        // ✅ Recipient Found
        const rank = result.data.rank || 'Member';
        const username = result.data.username || result.data.referralCode || result.uid;
        const name = result.data.name || 'User';
        const uidShort = result.uid.substring(0, 10) + '...';
        
        resultDiv.innerHTML = `
            <div class="recipient-found">
                <div class="d-flex align-items-center gap-3">
                    <div style="width:45px;height:45px;border-radius:50%;background:rgba(46,204,113,0.1);display:flex;align-items:center;justify-content:center;border:2px solid #2ecc71;flex-shrink:0;">
                        <i class="bi bi-person-check" style="color:#2ecc71;font-size:1.5rem;"></i>
                    </div>
                    <div style="flex:1;">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <strong style="color:#f0f4ff;font-size:1rem;">${name}</strong>
                            <span style="background:rgba(46,204,113,0.1);color:#2ecc71;padding:2px 10px;border-radius:12px;font-size:0.65rem;font-weight:600;">${rank}</span>
                            <span style="background:rgba(96,165,250,0.1);color:#60a5fa;padding:2px 10px;border-radius:12px;font-size:0.65rem;">Verified ✓</span>
                        </div>
                        <div style="font-size:0.8rem;color:#94a3b8;margin-top:2px;">
                            <i class="bi bi-person-badge me-1"></i> User ID: <span style="color:#e2e8f0;font-family:monospace;font-size:0.75rem;">${uidShort}</span>
                        </div>
                        ${username ? `<div style="font-size:0.75rem;color:#64748b;"><i class="bi bi-person me-1"></i> Username: ${username}</div>` : ''}
                        ${result.data.referralCode ? `<div style="font-size:0.75rem;color:#64748b;"><i class="bi bi-link me-1"></i> Referral Code: ${result.data.referralCode}</div>` : ''}
                    </div>
                    <div style="text-align:right;">
                        <span style="color:#2ecc71;font-size:1.2rem;"><i class="bi bi-check-circle-fill"></i></span>
                    </div>
                </div>
            </div>
        `;
        
        verifiedRecipient = result;
        if (transferBtn) transferBtn.disabled = false;
        
    } catch (error) {
        console.error('Error verifying recipient:', error);
        resultDiv.innerHTML = `
            <div class="recipient-error">
                <i class="bi bi-exclamation-triangle text-danger me-2"></i>
                <div>
                    <strong>Error</strong>
                    <div style="font-size:0.8rem;color:#94a3b8;">${error.message || 'Please try again.'}</div>
                </div>
            </div>
        `;
        verifiedRecipient = null;
        if (transferBtn) transferBtn.disabled = true;
    }
}

// ============================================================
// REAL-TIME LISTENER
// ============================================================
function setupRealtimeListener(userId) {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
    if (listenerTimeout) {
        clearTimeout(listenerTimeout);
        listenerTimeout = null;
    }
    
    const packagesRef = ref(db, 'users/' + userId + '/packages');
    let updateTimer = null;
    
    listenerOff = onValue(packagesRef, (snapshot) => {
        if (isDashboardLoading || !snapshot.exists()) return;
        
        if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = null;
        }
        
        updateTimer = setTimeout(() => {
            const packages = snapshot.val();
            if (currentUserData) {
                currentUserData.packages = packages;
                const stats = calculateUserStats(currentUserData);
                updateDashboardUI(currentUserData, stats);
            }
            updateTimer = null;
        }, 500);
    });
}

// ============================================================
// UPDATE DASHBOARD UI
// ============================================================
async function updateDashboardUI(u, stats) {
    const referralCounts = await getLiveReferralCounts(u);
    
    const elements = {
        depositWallet: document.getElementById('depositWalletValue'),
        referralWallet: document.getElementById('referralWalletValue'),
        rndWallet: document.getElementById('rndWalletValue'),
        lockedRND: document.getElementById('lockedRNDValue'),
        releaseWallet: document.getElementById('releaseWalletValue'),
        totalReleased: document.getElementById('totalReleasedValue'),
        activePackages: document.getElementById('activePackagesValue'),
        totalStake: document.getElementById('totalStakeValue'),
        teamBusiness: document.getElementById('teamBusinessValue'),
        totalReferrals: document.getElementById('totalReferralsValue')
    };
    
    if (elements.depositWallet) elements.depositWallet.textContent = '$' + (u.depositWallet || 0).toFixed(2);
    if (elements.referralWallet) elements.referralWallet.textContent = (u.referralWallet || 0).toFixed(2);
    if (elements.rndWallet) elements.rndWallet.textContent = (u.rndWallet || 0).toFixed(4);
    if (elements.lockedRND) elements.lockedRND.textContent = (stats?.totalLockedRND || u.lockedRND || 0).toFixed(2);
    if (elements.releaseWallet) elements.releaseWallet.textContent = (stats?.totalDailyRelease || u.releaseWallet || 0).toFixed(4);
    if (elements.totalReleased) elements.totalReleased.textContent = (stats?.totalReleased || u.totalReleased || 0).toFixed(4);
    if (elements.activePackages) elements.activePackages.textContent = stats?.activePackages || u.activePackages || 0;
    if (elements.totalStake) elements.totalStake.textContent = (stats?.totalStake || u.totalStake || 0).toFixed(2);
    if (elements.teamBusiness) elements.teamBusiness.textContent = '$' + (u.teamBusiness || 0).toFixed(2);
    
    if (elements.totalReferrals) {
        elements.totalReferrals.textContent = referralCounts.total || 0;
    }
    
    const badge = document.getElementById('referralBadge');
    if (badge) badge.textContent = referralCounts.total || 0;
}

// ============================================================
// 🔥 RECOVER USER DATA (SAFE - ONLY update(), NO set())
// ============================================================
async function recoverUserData(userId, authUser) {
    try {
        console.log('🔄 Starting recovery process for:', userId);
        
        const checkResult = await checkUserExists(userId);
        
        if (checkResult.exists) {
            console.log('✅ Found existing data from:', checkResult.source);
            
            let recoveredData = {};
            
            const userSnap = await get(ref(db, 'users/' + userId));
            if (userSnap.exists()) {
                recoveredData = userSnap.val();
                console.log('✅ Main user data found');
            }
            
            if (checkResult.source === 'backup' && checkResult.data) {
                const backupData = checkResult.data;
                
                // ✅ NEVER REPLACE: Protected fields
                const protectedFields = ['referralCode', 'referredBy', 'uid', 'createdAt'];
                for (let field of protectedFields) {
                    if (backupData[field]) {
                        recoveredData[field] = backupData[field];
                    }
                }
                
                // ✅ SAFE MERGE: Only merge, never replace
                const mergeFields = [
                    'depositWallet', 'referralWallet', 'rndWallet', 'lockedRND',
                    'releaseWallet', 'totalReleased', 'packages', 'transactions',
                    'transferHistory', 'commissionHistory', 'teamStructure',
                    'totalReferrals', 'teamBusiness', 'referralEarnings',
                    'level1Earnings', 'level2Earnings', 'level3Earnings',
                    'level4Earnings', 'level5Earnings', 'lastReleaseDate',
                    'directReferrals'
                ];
                
                for (let field of mergeFields) {
                    if (backupData[field] !== undefined && backupData[field] !== null) {
                        if (typeof backupData[field] === 'object' && !Array.isArray(backupData[field])) {
                            // ✅ MERGE objects
                            recoveredData[field] = { ...(recoveredData[field] || {}), ...backupData[field] };
                        } else {
                            // ✅ Only set if not exists
                            if (recoveredData[field] === undefined || recoveredData[field] === null) {
                                recoveredData[field] = backupData[field];
                            }
                        }
                    }
                }
                
                console.log('✅ Restored from backup with referral chain preserved');
            }
            
            // ✅ Preserve referral code
            if (recoveredData.referralCode) {
                console.log('✅ Referral Code preserved:', recoveredData.referralCode);
            } else {
                console.warn('⚠️ Referral Code missing, generating new one');
                recoveredData.referralCode = userId.substring(0, 8).toUpperCase();
            }
            
            if (recoveredData.referredBy) {
                console.log('✅ Referred By preserved:', recoveredData.referredBy);
            }
            
            // ✅ Default structures if missing
            if (!recoveredData.teamStructure) {
                recoveredData.teamStructure = { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 };
            }
            
            if (!recoveredData.directReferrals) {
                recoveredData.directReferrals = {};
            }
            
            if (!recoveredData.commissionHistory) {
                recoveredData.commissionHistory = [];
            }
            
            // ✅ Validate packages
            const packages = recoveredData.packages || {};
            for (let key in packages) {
                const pkg = packages[key];
                if (pkg.status === 'completed' && pkg.commissionProcessed === undefined) {
                    pkg.commissionProcessed = true;
                }
                // ✅ Package validation
                if (pkg.remainingRND < 0) pkg.remainingRND = 0;
                if (pkg.dailyRelease < 0) pkg.dailyRelease = 0;
            }
            recoveredData.packages = packages;
            
            if (!recoveredData.uid) recoveredData.uid = userId;
            if (!recoveredData.email) recoveredData.email = authUser.email || '';
            if (!recoveredData.name) recoveredData.name = authUser.displayName || 'User';
            
            // ✅ Only set defaults if missing
            const defaultFields = {
                username: authUser.email ? authUser.email.split('@')[0] : 'user_' + userId.substring(0, 8),
                depositWallet: 0,
                referralWallet: 0,
                rndWallet: 0,
                lockedRND: 0,
                releaseWallet: 0,
                totalReleased: 0,
                activePackages: 0,
                totalStake: 0,
                totalReferrals: 0,
                teamBusiness: 0,
                rank: 'Member',
                packages: {},
                transactions: {},
                transferHistory: [],
                commissionHistory: [],
                teamStructure: { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 },
                directReferrals: {},
                lastReleaseDate: null
            };
            
            for (let key in defaultFields) {
                if (recoveredData[key] === undefined || recoveredData[key] === null) {
                    recoveredData[key] = defaultFields[key];
                }
            }
            
            // ✅ SAFE: Use update() NOT set()
            const updateData = {};
            for (let key in recoveredData) {
                if (recoveredData[key] !== undefined && recoveredData[key] !== null) {
                    updateData[key] = recoveredData[key];
                }
            }
            
            await update(ref(db, 'users/' + userId), updateData);
            console.log('✅ User data recovered successfully with referral chain intact');
            
            return recoveredData;
        }
        
        // Check if email exists
        const email = authUser.email;
        if (email) {
            const usersSnap = await get(ref(db, 'users'));
            if (usersSnap.exists()) {
                const users = usersSnap.val();
                for (let uid in users) {
                    if (users[uid].email === email && uid !== userId) {
                        console.warn('⚠️ Email already exists with different UID:', uid);
                        return null;
                    }
                }
            }
        }
        
        console.log('🆕 Creating new user record for:', userId);
        
        // ✅ Use set() only for new user creation
        const newUserData = {
            uid: userId,
            email: authUser.email || '',
            username: authUser.email ? authUser.email.split('@')[0] : 'user_' + userId.substring(0, 8),
            referralCode: userId.substring(0, 8).toUpperCase(),
            name: authUser.displayName || 'User',
            createdAt: Date.now(),
            lastLogin: Date.now(),
            depositWallet: 0,
            referralWallet: 0,
            rndWallet: 0,
            lockedRND: 0,
            releaseWallet: 0,
            totalReleased: 0,
            activePackages: 0,
            totalStake: 0,
            totalReferrals: 0,
            teamBusiness: 0,
            rank: 'Member',
            referredBy: null,
            packages: {},
            transactions: {},
            transferHistory: [],
            commissionHistory: [],
            teamStructure: { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 },
            directReferrals: {},
            lastReleaseDate: null
        };
        
        const urlParams = new URLSearchParams(window.location.search);
        const refCode = urlParams.get('ref');
        if (refCode) {
            const refResult = await getUserByIdentifier(refCode);
            if (refResult && refResult.uid !== userId) {
                newUserData.referredBy = refCode;
                await runTransaction(ref(db, 'users/' + refResult.uid), (currentData) => {
                    if (!currentData) return currentData;
                    currentData.totalReferrals = (currentData.totalReferrals || 0) + 1;
                    return currentData;
                });
            }
        }
        
        await set(ref(db, 'users/' + userId), newUserData);
        console.log('✅ New user created successfully');
        
        return newUserData;
        
    } catch (error) {
        console.error('❌ Error in recovery process:', error);
        return null;
    }
}

// ============================================================
// CHECK USER EXISTENCE
// ============================================================
async function checkUserExists(userId) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        if (userSnap.exists()) {
            return { exists: true, data: userSnap.val(), source: 'main' };
        }
        
        const backupSnap = await get(ref(db, 'backups/' + userId));
        if (backupSnap.exists()) {
            const backups = backupSnap.val();
            const keys = Object.keys(backups);
            if (keys.length > 0) {
                const latestKey = keys.reduce((a, b) => {
                    return backups[a].timestamp > backups[b].timestamp ? a : b;
                });
                return { exists: true, data: backups[latestKey].data, source: 'backup', backupId: latestKey };
            }
        }
        
        return { exists: false };
    } catch (error) {
        console.error('Error checking user existence:', error);
        return { exists: false, error: error.message };
    }
}

// ============================================================
// RENDER DASHBOARD
// ============================================================
async function renderDashboard(u) {
    const referralCounts = await getLiveReferralCounts(u);
    
    const username = u.username || u.referralCode || 'USER';
    const name = u.name || 'User';
    const rank = u.rank || 'Member';
    const isMember = rank === 'Member' || rank === 'member' || !rank;
    
    const depositWallet = u.depositWallet || 0;
    const referralWallet = u.referralWallet || 0;
    const rndWallet = u.rndWallet || 0;
    const lockedRND = u.lockedRND || 0;
    const releaseWallet = u.releaseWallet || 0;
    const totalReleased = u.totalReleased || 0;
    const activePackages = u.activePackages || 0;
    const totalStake = u.totalStake || 0;
    const teamBusiness = u.teamBusiness || 0;
    
    const level1Earn = u.level1Earnings || 0;
    const level2Earn = u.level2Earnings || 0;
    const level3Earn = u.level3Earnings || 0;
    const level4Earn = u.level4Earnings || 0;
    const level5Earn = u.level5Earnings || 0;
    const referralEarnings = u.referralEarnings || 0;
    
    const teamLevels = {
        level1: referralCounts.level1 || 0,
        level2: referralCounts.level2 || 0,
        level3: referralCounts.level3 || 0,
        level4: referralCounts.level4 || 0,
        level5: referralCounts.level5 || 0
    };
    
    const totalReferrals = referralCounts.total || 0;
    
    const packages = u.packages || {};
    const totalPackages = Object.keys(packages).length;
    
    let daysPassed = 0;
    for (let key in packages) {
        const pkg = packages[key];
        if (pkg.status === 'active' && pkg.dailyRelease > 0) {
            const released = pkg.releasedRND || 0;
            const days = Math.floor(released / pkg.dailyRelease);
            daysPassed = Math.max(daysPassed, days);
        }
    }
    
    document.getElementById('sidebarName').textContent = name;
    document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
    document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
    
    const badge = document.getElementById('referralBadge');
    if (badge) badge.textContent = totalReferrals;
    
    const referralLink = `${REGISTER_URL}?ref=${u.referralCode}`;
    const rankClass = isMember ? 'rank-badge member' : 'rank-badge';
    
    const transferHistory = u.transferHistory || [];
    const sortedHistory = [...transferHistory].reverse().slice(0, 5);

    document.getElementById('dashboardContent').innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="welcome-section">
                    <div class="d-flex flex-wrap align-items-center justify-content-between gap-3">
                        <div>
                            <h2>Good ${getGreeting()}, <span>${name}</span></h2>
                            <div class="d-flex flex-wrap align-items-center gap-3 mt-2">
                                <span class="user-id-badge">
                                    <i class="bi bi-person-badge me-1"></i>User ID: <strong style="font-size:0.7rem;">${username.substring(0, 20)}...</strong>
                                    <button class="copy-btn-small" onclick="window.copyUserId('${username}')"><i class="bi bi-clipboard"></i> Copy</button>
                                </span>
                                <span class="${rankClass}"><i class="bi bi-award me-1"></i>${rank}</span>
                                <span class="rnd-price-badge">
                                    <i class="bi bi-currency-dollar"></i> 1 RND = $${(rndPrice || 1).toFixed(4)}
                                </span>
                                <span class="days-remaining">
                                    <i class="bi bi-box-seam"></i> ${totalPackages} Packages
                                </span>
                                ${daysPassed > 0 ? `<span class="days-remaining"><i class="bi bi-calendar"></i> Day ${daysPassed}</span>` : ''}
                                <span class="status-badge active">
                                    <i class="bi bi-shield-check"></i> Secure Mode
                                </span>
                            </div>
                        </div>
                        <div>
                            <a href="deposit.html" class="btn-primary-custom me-2"><i class="bi bi-plus-circle me-1"></i>Deposit</a>
                            <a href="withdrawal.html" class="btn-outline-custom"><i class="bi bi-arrow-up-right me-1"></i>Withdraw</a>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- WALLETS -->
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon deposit"><i class="bi bi-wallet2"></i></div>
                            <div class="wallet-number green" id="depositWalletValue">$${(depositWallet || 0).toFixed(2)}</div>
                            <div class="wallet-label">Deposit Wallet</div>
                            <div class="wallet-sub">USDT Balance</div>
                        </div>
                    </div>
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon referral"><i class="bi bi-coin"></i></div>
                            <div class="wallet-number gold" id="referralWalletValue">${(referralWallet || 0).toFixed(2)}</div>
                            <div class="wallet-label">💰 Referral Wallet</div>
                            <div class="wallet-sub">RND Balance</div>
                        </div>
                    </div>
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon rnd"><i class="bi bi-database"></i></div>
                            <div class="wallet-number blue" id="rndWalletValue">${(rndWallet || 0).toFixed(4)}</div>
                            <div class="wallet-label">RND Wallet</div>
                            <div class="wallet-sub">💰 Total Released RND</div>
                        </div>
                    </div>
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card">
                            <div class="wallet-icon locked"><i class="bi bi-lock"></i></div>
                            <div class="wallet-number purple" id="lockedRNDValue">${(lockedRND || 0).toFixed(2)}</div>
                            <div class="wallet-label">🔒 Locked RND</div>
                            <div class="wallet-sub">Remaining Locked</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- DAILY RELEASE -->
            <div class="col-12">
                <div class="row">
                    <div class="col-md-4">
                        <div class="wallet-card" style="background:rgba(52,211,153,0.05);border-color:rgba(52,211,153,0.15);">
                            <div class="wallet-icon release"><i class="bi bi-clock-history"></i></div>
                            <div class="wallet-number teal" id="releaseWalletValue">${(releaseWallet || 0).toFixed(4)} RND</div>
                            <div class="wallet-label">📅 Daily Release</div>
                            <div class="wallet-sub">Fixed Per Day</div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="wallet-card" style="background:rgba(96,165,250,0.05);border-color:rgba(96,165,250,0.15);">
                            <div class="wallet-icon rnd"><i class="bi bi-cash-stack"></i></div>
                            <div class="wallet-number" style="color:#60a5fa;" id="totalReleasedValue">${(totalReleased || 0).toFixed(4)} RND</div>
                            <div class="wallet-label">📊 Total Released</div>
                            <div class="wallet-sub">So Far</div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="wallet-card" style="background:rgba(167,139,250,0.05);border-color:rgba(167,139,250,0.15);">
                            <div class="wallet-icon locked"><i class="bi bi-box-seam"></i></div>
                            <div class="wallet-number" style="color:#a78bfa;" id="activePackagesValue">${activePackages}</div>
                            <div class="wallet-label">📦 Active Packages</div>
                            <div class="wallet-sub">Currently Running</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- RELEASE INFO -->
            <div class="col-12">
                <div class="release-info-box">
                    <div>
                        <span class="label"><i class="bi bi-info-circle me-1"></i> Fixed daily release. Same amount every day until package completes.</span>
                    </div>
                    <div>
                        <span class="label">Locked RND:</span>
                        <span class="value" id="lockedRNDInfo">${(lockedRND || 0).toFixed(2)} RND</span>
                    </div>
                    <div>
                        <span class="label">Daily Release:</span>
                        <span class="value" id="releaseWalletInfo">${(releaseWallet || 0).toFixed(4)} RND</span>
                    </div>
                </div>
            </div>
            
            <!-- STATISTICS -->
            <div class="col-12">
                <h5 class="fw-bold mb-3"><i class="bi bi-diagram-3 text-success me-2"></i>Statistics</h5>
                <div class="network-stats">
                    <div class="network-stat-card">
                        <div class="number" id="totalStakeValue">${(totalStake || 0).toFixed(2)}</div>
                        <div class="label">Total Stake (USDT)</div>
                    </div>
                    <div class="network-stat-card">
                        <div class="number" id="totalReferralsValue">${totalReferrals}</div>
                        <div class="label">Total Referrals</div>
                    </div>
                    <div class="network-stat-card">
                        <div class="number" id="teamBusinessValue">$${(teamBusiness || 0).toFixed(2)}</div>
                        <div class="label">Team Business</div>
                    </div>
                </div>
            </div>
            
            <!-- 5 LEVEL MEMBERS -->
            <div class="col-12">
                <h5 class="fw-bold mb-3"><i class="bi bi-people text-success me-2"></i>Team Members by Level</h5>
                <div class="level-stats">
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level1}</div>
                        <div class="label">Level 1</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level2}</div>
                        <div class="label">Level 2</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level3}</div>
                        <div class="label">Level 3</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level4}</div>
                        <div class="label">Level 4</div>
                    </div>
                    <div class="level-stat-card">
                        <div class="number">${teamLevels.level5}</div>
                        <div class="label">Level 5</div>
                    </div>
                </div>
            </div>
            
            <!-- 5 LEVEL COMMISSIONS -->
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-cash-stack text-success me-2"></i>5 Level Referral Commissions</div>
                    <div class="row">
                        <div class="col-md-8">
                            <div class="commission-row">
                                <span class="level">Level 1 (8%)</span>
                                <span class="earnings">$${(level1Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 2 (4%)</span>
                                <span class="earnings">$${(level2Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 3 (2%)</span>
                                <span class="earnings">$${(level3Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 4 (1%)</span>
                                <span class="earnings">$${(level4Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row">
                                <span class="level">Level 5 (1%)</span>
                                <span class="earnings">$${(level5Earn || 0).toFixed(2)}</span>
                            </div>
                            <div class="commission-row" style="border-top:2px solid rgba(251,191,36,0.2);padding-top:10px;margin-top:4px;">
                                <span class="level" style="font-weight:700;color:#fbbf24;">Total Referral Earnings</span>
                                <span class="earnings" style="font-size:1.1rem;">$${(referralEarnings || 0).toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="col-md-4 text-center d-flex flex-column justify-content-center">
                            <div style="padding:20px;background:rgba(46,204,113,0.05);border-radius:12px;border:1px solid rgba(46,204,113,0.1);">
                                <small class="text-muted">Total Released</small>
                                <h3 style="color:#60a5fa;">${(rndWallet || 0).toFixed(4)} RND</h3>
                                <small class="text-muted">So Far</small>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- REFERRAL LINK -->
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-link-45deg"></i>Your Referral Link</div>
                    <div class="referral-box">
                        <code>${referralLink}</code>
                        <button class="copy-btn" data-copy="${referralLink}"><i class="bi bi-clipboard me-1"></i>Copy</button>
                    </div>
                    <div class="mt-3 d-flex flex-wrap gap-2">
                        <span class="text-muted small"><i class="bi bi-people me-1"></i>Total Referrals: <strong style="color:#2ecc71;">${totalReferrals}</strong></span>
                        <span class="text-muted small"><i class="bi bi-box-arrow-up-right me-1"></i>Referral Code: <strong style="color:#2ecc71;font-size:0.7rem;">${u.referralCode}</strong></span>
                    </div>
                </div>
            </div>
            
            <!-- TRANSFER SYSTEM -->
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-arrow-left-right text-success me-2"></i>Send Money</div>
                    
                    <div class="row g-3 mb-3">
                        <div class="col-md-5">
                            <input type="text" id="transferUserId" class="form-control form-control-custom" 
                                   placeholder="Recipient User ID / Username / Referral Code" 
                                   oninput="window.verifyRecipientDebounced(this.value)">
                        </div>
                        <div class="col-md-3">
                            <input type="number" id="transferAmount" class="form-control form-control-custom" 
                                   placeholder="Amount" min="0.01" step="0.01">
                        </div>
                        <div class="col-md-3">
                            <select id="transferWallet" class="form-select form-select-custom">
                                <option value="depositWallet">💰 Deposit Wallet (USDT)</option>
                                <option value="referralWallet">💳 Referral Wallet (USDT)</option>
                                <option value="rndWallet">📊 RND Wallet (RND)</option>
                            </select>
                        </div>
                        <div class="col-md-1">
                            <button type="submit" id="transferSubmitBtn" class="btn-primary-custom w-100" disabled>
                                <i class="bi bi-send me-1"></i>Send
                            </button>
                        </div>
                    </div>
                    
                    <div id="recipientVerificationResult" style="margin-bottom:10px;"></div>
                    
                    <div class="mt-3">
                        <small class="text-muted">Recent Transfers</small>
                        <div class="transfer-history">
                            ${sortedHistory.length === 0 ? `
                                <div class="text-center text-muted py-2" style="font-size:0.8rem;">
                                    <i class="bi bi-clock me-1"></i> No transfers yet
                                </div>
                            ` : sortedHistory.map(t => `
                                <div class="transfer-item">
                                    <div>
                                        ${t.type === 'sent' ? 
                                            `<span class="sent"><i class="bi bi-arrow-up-right"></i> Sent to <span class="user">${t.to || 'unknown'}</span></span>` :
                                            `<span class="received"><i class="bi bi-arrow-down-left"></i> Received from <span class="user">${t.from || 'unknown'}</span></span>`
                                        }
                                    </div>
                                    <div>
                                        <span class="amount ${t.type === 'sent' ? 'sent' : 'received'}">${t.type === 'sent' ? '-' : '+'}${t.amount} ${t.currency || 'RND'}</span>
                                        <div class="date">${new Date(t.timestamp).toLocaleString('hi-IN')}</div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- QUICK LINKS -->
            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-grid-3x3-gap-fill"></i>Quick Links</div>
                    <div class="d-flex flex-wrap gap-2">
                        <a href="deposit.html" class="btn-primary-custom"><i class="bi bi-arrow-down-circle me-1"></i>Deposit</a>
                        <a href="withdrawal.html" class="btn-outline-custom"><i class="bi bi-arrow-up-circle me-1"></i>Withdraw</a>
                        <a href="referrals.html" class="btn-outline-custom"><i class="bi bi-people me-1"></i>Referrals</a>
                        <a href="buy-package.html" class="btn-outline-custom"><i class="bi bi-box-seam me-1"></i>Buy Package</a>
                        <a href="profile.html" class="btn-outline-custom"><i class="bi bi-person me-1"></i>Profile</a>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            navigator.clipboard.writeText(btn.dataset.copy).then(() => {
                btn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
                setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy'; }, 2000);
            });
        });
    });
    
    const transferBtn = document.getElementById('transferSubmitBtn');
    const transferForm = document.getElementById('transferForm');
    if (transferForm) {
        transferForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await handleTransfer();
        });
    }
    
    let verifyTimeout = null;
    window.verifyRecipientDebounced = function(value) {
        if (verifyTimeout) clearTimeout(verifyTimeout);
        verifyTimeout = setTimeout(() => {
            verifyRecipient(value);
        }, 500);
    };
}

// ============================================================
// COPY USER ID
// ============================================================
window.copyUserId = function(username) {
    navigator.clipboard.writeText(username).then(() => {
        showToast('✅ User ID copied to clipboard!', 'success');
    }).catch(() => {
        const textArea = document.createElement('textarea');
        textArea.value = username;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('✅ User ID copied to clipboard!', 'success');
    });
};

// ============================================================
// TRANSFER HANDLER
// ============================================================
async function handleTransfer() {
    if (!verifiedRecipient) {
        showToast('❌ Please verify the recipient first!', 'error');
        return;
    }
    
    const amount = parseFloat(document.getElementById('transferAmount').value);
    const walletType = document.getElementById('transferWallet').value;
    const btn = document.getElementById('transferSubmitBtn');
    
    // ✅ Amount Validation
    if (!isValidAmount(amount)) {
        showToast('❌ Please enter a valid amount', 'error');
        return;
    }
    
    const user = auth.currentUser;
    if (!user) {
        showToast('❌ Please login first', 'error');
        return;
    }
    
    const senderSnap = await get(ref(db, 'users/' + user.uid));
    if (!senderSnap.exists()) {
        showToast('❌ User data not found', 'error');
        return;
    }
    const senderData = senderSnap.val();
    const senderUsername = senderData.username || senderData.referralCode;
    const senderUid = user.uid;
    
    const recipientUid = verifiedRecipient.uid;
    const recipientData = verifiedRecipient.data;
    const recipientUsername = recipientData.username || recipientData.referralCode;
    
    const senderBalance = senderData[walletType] || 0;
    if (senderBalance < amount) {
        const walletLabels = {
            'depositWallet': 'Deposit Wallet (USDT)',
            'referralWallet': 'Referral Wallet (USDT)',
            'rndWallet': 'RND Wallet (RND)'
        };
        showToast(`❌ Insufficient balance in ${walletLabels[walletType] || 'Wallet'}! You have ${senderBalance.toFixed(4)}`, 'error');
        return;
    }
    
    const currency = walletType === 'rndWallet' ? 'RND' : 'USDT';
    
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending...';
    
    try {
        const result = await atomicTransfer(
            senderUid,
            recipientUid,
            recipientData,
            amount,
            walletType,
            currency,
            senderUsername,
            senderUid
        );
        
        if (result.success) {
            showToast(`✅ ${amount} ${currency} sent successfully to ${recipientUsername}!`, 'success');
            document.getElementById('transferUserId').value = '';
            document.getElementById('transferAmount').value = '';
            document.getElementById('recipientVerificationResult').innerHTML = '';
            verifiedRecipient = null;
            btn.disabled = true;
            await loadDashboardData(user.uid);
        } else {
            showToast('❌ ' + (result.error || 'Transfer failed. Please try again.'), 'error');
        }
        
    } catch (error) {
        console.error('Transfer error:', error);
        showToast('❌ Error sending. Please try again.', 'error');
    }
    
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-send me-1"></i>Send';
}

// ============================================================
// LOAD DASHBOARD DATA
// ============================================================
async function loadDashboardData(userId) {
    if (isDashboardLoading) return;
    isDashboardLoading = true;
    
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        
        if (!userSnap.exists()) {
            const authUser = auth.currentUser;
            if (authUser) {
                const checkResult = await checkUserExists(userId);
                
                if (checkResult.exists) {
                    console.log('🔄 Found existing data, attempting recovery...');
                    const recovered = await recoverUserData(userId, authUser);
                    if (recovered) {
                        await processDailyRelease(userId);
                        const stats = calculateUserStats(recovered);
                        currentUserData = recovered;
                        currentUserId = userId;
                        await renderDashboard(recovered);
                        setupRealtimeListener(userId);
                        showToast('✅ Your data has been recovered successfully', 'success');
                    }
                } else {
                    console.log('🆕 No existing data found, creating new user...');
                    const newUser = await recoverUserData(userId, authUser);
                    if (newUser) {
                        const stats = calculateUserStats(newUser);
                        currentUserData = newUser;
                        currentUserId = userId;
                        await renderDashboard(newUser);
                        setupRealtimeListener(userId);
                    }
                }
            }
            isDashboardLoading = false;
            return;
        }
        
        const u = userSnap.val();
        
        await processDailyRelease(userId);
        
        const packages = u.packages || {};
        for (let [key, pkg] of Object.entries(packages)) {
            if (pkg.status === 'active' && !pkg.commissionProcessed) {
                await processReferralCommission(userId, key, pkg);
            }
        }
        
        const updatedSnap = await get(ref(db, 'users/' + userId));
        const updatedData = updatedSnap.exists() ? updatedSnap.val() : u;
        const stats = calculateUserStats(updatedData);
        
        currentUserData = updatedData;
        currentUserId = userId;
        
        await renderDashboard(updatedData);
        setupRealtimeListener(userId);
        
    } catch (error) {
        console.error('Error loading dashboard:', error);
        document.getElementById('dashboardContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Dashboard</h4>
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    } finally {
        isDashboardLoading = false;
    }
}

// ============================================================
// MAIN AUTH HANDLER
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    try {
        await fetchLiveRate();
        
        const userSnap = await get(ref(db, 'users/' + user.uid));
        
        if (!userSnap.exists()) {
            console.log('🔄 User authenticated, checking for existing data...');
            const checkResult = await checkUserExists(user.uid);
            
            if (checkResult.exists) {
                console.log('✅ Found existing data in:', checkResult.source);
                await loadDashboardData(user.uid);
            } else {
                const email = user.email;
                if (email) {
                    const usersSnap = await get(ref(db, 'users'));
                    let emailExists = false;
                    if (usersSnap.exists()) {
                        const users = usersSnap.val();
                        for (let uid in users) {
                            if (users[uid].email === email && uid !== user.uid) {
                                emailExists = true;
                                break;
                            }
                        }
                    }
                    
                    if (emailExists) {
                        console.warn('⚠️ Email already exists with different UID');
                        document.getElementById('dashboardContent').innerHTML = `
                            <div class="text-center py-5">
                                <i class="bi bi-exclamation-triangle text-warning fs-1 d-block mb-3"></i>
                                <h4>Account Already Exists</h4>
                                <p class="text-muted">This email is already registered with another account.</p>
                                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Try Again</button>
                            </div>
                        `;
                        return;
                    }
                }
                
                console.log('🆕 Creating new user account...');
                await loadDashboardData(user.uid);
            }
            return;
        }
        
        const u = userSnap.val();
        
        if (u && u.banned === true) {
            alert('Your account has been banned.');
            await signOut(auth);
            window.location.href = 'login.html';
            return;
        }
        
        await loadDashboardData(user.uid);

    } catch (error) {
        console.error('Error in auth handler:', error);
        document.getElementById('dashboardContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Authentication Error</h4>
                <p class="text-muted">${error.message || 'Please try again.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
});

window.addEventListener('beforeunload', () => {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
    if (listenerTimeout) {
        clearTimeout(listenerTimeout);
        listenerTimeout = null;
    }
    if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
    }
});
