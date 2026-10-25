// ============================================================
// RND DIRECT REFERRAL OFFER — FINAL PRODUCTION SCRIPT (v11.0)
// ============================================================
// - Hardcoded DB path (no settings dependency)
// - Fixed: Scans user's UID directly for direct_offer_50pack_oct2026
// - Guaranteed to unlock withdrawal for 5+ referrals
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, onValue, runTransaction } from "firebase/database";

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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// 🆕 HARDCODED CONFIGURATION (No Settings Fetching)
// ============================================================
const LIVE_CAMPAIGN_ID = 'direct_offer_50pack_oct2026';
const CAMPAIGN = {
    campaignId: LIVE_CAMPAIGN_ID,
    campaignName: 'RND $50+ Package Direct Referral Offer',
    startDate: new Date('2026-10-10T00:00:00+05:30'),
    endDate: new Date('2026-10-24T23:59:59+05:30'),
    requiredPackageAmount: 50,
    rewardPerReferral: 10,
    cycleSize: 5,
    cycleReward: 50,
    maxQualifying: Infinity,
    minReferralsForWithdrawal: 5,
    status: 'active'
};

// DOM REFS
const $ = id => document.getElementById(id);
const el = {
    loadingOverlay: $('loadingOverlay'), toastContainer: $('toastContainer'),
    userAvatar: $('userAvatar'), userName: $('userName'), logoutBtn: $('logoutBtn'),
    countdownDays: $('countdownDays'), countdownHours: $('countdownHours'),
    countdownMinutes: $('countdownMinutes'), countdownSeconds: $('countdownSeconds'),
    countdownWrapper: $('countdownWrapper'), campaignEndedMessage: $('campaignEndedMessage'),
    campaignStatusBadge: $('campaignStatusBadge'), statDirectRefs: $('statDirectRefs'),
    statReferralPeriod: $('statReferralPeriod'), statEligibleReward: $('statEligibleReward'),
    statRewardNote: $('statRewardNote'), statNextMilestone: $('statNextMilestone'),
    statNextMilestoneSub: $('statNextMilestoneSub'), statMaxReward: $('statMaxReward'),
    progressCurrent: $('progressCurrent'), progressTarget: $('progressTarget'),
    progressFill: $('progressFill'), needMore: $('needMore'),
    nextMilestoneText: $('nextMilestoneText'), cycleProgressGrid: $('cycleProgressGrid'),
    referralLinkDisplay: $('referralLinkDisplay'), copyReferralBtn: $('copyReferralBtn'),
    totalReferralsDisplay: $('totalReferralsDisplay'), referralCodeDisplay: $('referralCodeDisplay'),
    withdrawalSection: $('withdrawalSection'), withdrawAmount: $('withdrawAmount'),
    walletAddressInput: $('walletAddressInput'), walletValidationMsg: $('walletValidationMsg'),
    walletFormGroup: $('walletFormGroup'), withdrawBtn: $('withdrawBtn'),
    withdrawalStatus: $('withdrawalStatus'), withdrawalInfoBox: $('withdrawalInfoBox'),
    withdrawalInfoText: $('withdrawalInfoText'), withdrawalDetails: $('withdrawalDetails'),
    detailAmount: $('detailAmount'), detailWallet: $('detailWallet'),
    detailPaidDate: $('detailPaidDate'), detailTxHash: $('detailTxHash'),
    withdrawalSubtitle: $('withdrawalSubtitle'), notEligibleBox: $('notEligibleBox'),
    walletAmount: $('walletAmount'), walletLabel: $('walletLabel'),
    walletStatusText: $('walletStatusText'), finalBadge: $('finalBadge'),
    rewardWalletCard: $('rewardWalletCard'), daysPopup: $('daysPopup'),
    popupIcon: $('popupIcon'), popupTitle: $('popupTitle'), popupText: $('popupText'),
    popupRewardAmount: $('popupRewardAmount'), popupDaysRemaining: $('popupDaysRemaining'),
    popupCloseBtn: $('popupCloseBtn'), confirmationModal: $('confirmationModal'),
    confirmAmount: $('confirmAmount'), confirmWallet: $('confirmWallet'),
    confirmCancel: $('confirmCancel'), confirmSubmit: $('confirmSubmit')
};

let currentUserId = null;
let currentUserData = null;
let directReferrals = 0;
let countdownInterval = null;
let withdrawalData = null;
let campaignRewardSnapshot = null;
let isWithdrawalFinalized = false;
let isProcessingWithdrawal = false;
let referralRefreshInterval = null;
let firebaseServerOffset = 0;
let withdrawalListenerUnsubscribe = null;
let serverTimeListenerUnsubscribe = null;
let listenersInitialized = false;

// UTILS
function syncFirebaseServerTime() {
    if (serverTimeListenerUnsubscribe) { try { serverTimeListenerUnsubscribe(); } catch (e) {} serverTimeListenerUnsubscribe = null; }
    try {
        serverTimeListenerUnsubscribe = onValue(ref(db, '.info/serverTimeOffset'), (snapshot) => {
            const offset = Number(snapshot.val() || 0);
            firebaseServerOffset = Number.isFinite(offset) ? offset : 0;
            if (typeof updateUI === 'function' && CAMPAIGN) { try { updateUI(); } catch (e) {} }
        }, () => { firebaseServerOffset = 0; });
    } catch (error) { firebaseServerOffset = 0; }
}
function getCampaignNow() { return new Date(Date.now() + firebaseServerOffset); }
function isUserActive(userData) {
    if (!userData || typeof userData !== 'object') return false;
    const packages = userData.packages || {};
    for (const packageId of Object.keys(packages)) {
        const pkg = packages[packageId];
        if (pkg && String(pkg.status || '').toLowerCase() === 'active' && Number(pkg.usdtAmount || 0) > 0) return true;
    }
    return false;
}
function normalizeTimestamp(value) {
    if (!value) return null;
    if (typeof value === 'number') return value > 0 ? value : null;
    if (/^\d+$/.test(String(value))) return Number(value) > 0 ? Number(value) : null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function getPackageActivationTime(pkg) {
    if (!pkg) return null;
    for (const v of [pkg.activationAt, pkg.activatedAt, pkg.activeAt]) {
        const ts = normalizeTimestamp(v); if (ts) return ts;
    }
    if (String(pkg.status || '').toLowerCase() === 'active') {
        return normalizeTimestamp(pkg.purchaseDate) || normalizeTimestamp(pkg.createdAt);
    }
    return null;
}
function hasCampaignActivePackage(userData) {
    if (!isUserActive(userData) || !CAMPAIGN) return false;
    const packages = userData.packages || {};
    for (const packageId of Object.keys(packages)) {
        const pkg = packages[packageId];
        if (!pkg || String(pkg.status || '').toLowerCase() !== 'active') continue;
        if (Number(pkg.usdtAmount || 0) < CAMPAIGN.requiredPackageAmount) continue;
        const activationTime = getPackageActivationTime(pkg);
        if (activationTime >= CAMPAIGN.startDate.getTime() && activationTime <= CAMPAIGN.endDate.getTime()) return true;
    }
    return false;
}
async function getCampaignDirectReferrals(userId) {
    try {
        if (!db || !userId || !CAMPAIGN) return 0;
        const ownerSnap = await get(ref(db, 'users/' + userId));
        if (!ownerSnap.exists()) return 0;
        const owner = ownerSnap.val();
        if (!isUserActive(owner)) return 0;
        const usersSnap = await get(ref(db, 'users'));
        if (!usersSnap.exists()) return 0;
        const users = usersSnap.val() || {};
        const counted = new Set();
        for (const [candidateUid, candidate] of Object.entries(users)) {
            if (!candidate || candidateUid === userId) continue;
            let isDirect = (candidate.sponsorUid === userId || candidate.referredByUid === userId);
            if (!isDirect) {
                const legacy = candidate.referredBy || candidate.sponsor;
                if (legacy && (String(legacy) === String(userId) || String(legacy) === String(owner.referralCode) || String(legacy) === String(owner.username))) isDirect = true;
            }
            if (!isDirect || !isUserActive(candidate) || !hasCampaignActivePackage(candidate)) continue;
            counted.add(candidateUid);
        }
        return Math.max(0, Math.min(Number(counted.size) || 0, CAMPAIGN.maxQualifying));
    } catch (error) { return 0; }
}
function calculateReward(directCount) {
    const count = Math.max(0, Number(directCount) || 0);
    return (count <= 0 || !CAMPAIGN) ? 0 : Number((count * CAMPAIGN.rewardPerReferral).toFixed(2));
}
function getCurrentCycleProgress(directCount) {
    if (!CAMPAIGN) return 0;
    const count = Math.max(0, Number(directCount) || 0);
    if (count === 0) return 0;
    const remainder = count % CAMPAIGN.cycleSize;
    return remainder === 0 ? CAMPAIGN.cycleSize : remainder;
}
function isWithdrawalEligible(finalDirectCount) {
    if (!CAMPAIGN) return false;
    return Math.max(0, Number(finalDirectCount) || 0) >= CAMPAIGN.minReferralsForWithdrawal;
}
function getCampaignStatus() {
    if (!CAMPAIGN) return 'NOT_LOADED';
    const now = getCampaignNow().getTime();
    const start = CAMPAIGN.startDate.getTime();
    const end = CAMPAIGN.endDate.getTime();
    if (now < start) return 'UPCOMING';
    if (now <= end) return 'ACTIVE';
    return 'ENDED';
}
function getTimeRemaining() {
    if (!CAMPAIGN) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
    const now = getCampaignNow(); const status = getCampaignStatus();
    if (status === 'UPCOMING') {
        const diff = CAMPAIGN.startDate - now;
        if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
        return { days: Math.floor(diff / 86400000), hours: Math.floor((diff % 86400000) / 3600000), minutes: Math.floor((diff % 3600000) / 60000), seconds: Math.floor((diff % 60000) / 1000) };
    } else if (status === 'ACTIVE') {
        const diff = CAMPAIGN.endDate - now;
        if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
        return { days: Math.floor(diff / 86400000), hours: Math.floor((diff % 86400000) / 3600000), minutes: Math.floor((diff % 3600000) / 60000), seconds: Math.floor((diff % 60000) / 1000) };
    }
    return { days: 0, hours: 0, minutes: 0, seconds: 0 };
}
function formatTimeRemaining(time) {
    if (time.days === 0 && time.hours === 0 && time.minutes === 0 && time.seconds === 0) return 'Offer has ended';
    return `${time.days}d ${time.hours}h ${time.minutes}m ${time.seconds}s`;
}

// ============================================================
// 🔥 SMART DB FETCH (Scans direct path AND sub-paths)
// ============================================================
async function getCampaignRewardSnapshot(userId) {
    if (!db || !userId) return null;
    try {
        // 1. Direct Check
        let snap = await get(ref(db, `campaign_rewards/${userId}/${LIVE_CAMPAIGN_ID}`));
        if (snap.exists()) {
            const data = snap.val();
            if (data && data.isFinalized === true) {
                isWithdrawalFinalized = true;
                return data;
            }
        }

        // 2. Check inside user's campaigns for any active finalized campaign
        const userCampaignsSnap = await get(ref(db, `campaign_rewards/${userId}`));
        if (userCampaignsSnap.exists()) {
            const allData = userCampaignsSnap.val();
            for (const cid in allData) {
                const data = allData[cid];
                if (data && data.isFinalized === true && Number(data.finalReward) > 0) {
                    isWithdrawalFinalized = true;
                    return data;
                }
            }
        }

        return null;
    } catch (e) { 
        console.error("Error fetching snapshot:", e);
        return null; 
    }
}

async function finalizeCampaignReward(userId) {
    if (!db || !userId || getCampaignStatus() !== 'ENDED') return null;
    try {
        const existing = await getCampaignRewardSnapshot(userId);
        if (existing && existing.isFinalized === true) { campaignRewardSnapshot = existing; return existing; }

        const finalCount = await getCampaignDirectReferrals(userId);
        const finalReward = calculateReward(finalCount);

        const snapshotData = {
            campaignId: LIVE_CAMPAIGN_ID, campaignName: CAMPAIGN.campaignName, userId: userId,
            finalDirectCount: finalCount, finalReward: finalReward, snapshotAt: Date.now(),
            status: 'available', isFinalized: true, walletAddress: null, withdrawalId: null,
            transactionId: null, txHash: null, paidAt: null
        };

        const result = await runTransaction(ref(db, `campaign_rewards/${userId}/${LIVE_CAMPAIGN_ID}`), currentData => {
            if (currentData && currentData.isFinalized === true) return currentData;
            return snapshotData;
        });

        if (result.committed && result.snapshot.exists()) {
            campaignRewardSnapshot = result.snapshot.val(); isWithdrawalFinalized = true; return campaignRewardSnapshot;
        }
        return await getCampaignRewardSnapshot(userId);
    } catch (error) { return null; }
}

async function checkWithdrawalStatus(userId) {
    if (!db || !userId) return null;
    const snap = await get(ref(db, `campaign_rewards/${userId}/${LIVE_CAMPAIGN_ID}`));
    return snap.exists() ? snap.val() : null;
}

function setupWithdrawalListener(userId) {
    if (withdrawalListenerUnsubscribe) { withdrawalListenerUnsubscribe(); withdrawalListenerUnsubscribe = null; }
    if (!userId) { withdrawalData = null; return; }
    withdrawalListenerUnsubscribe = onValue(ref(db, `campaign_rewards/${userId}/${LIVE_CAMPAIGN_ID}`), (snapshot) => {
        withdrawalData = snapshot.exists() ? snapshot.val() : null; updateUI();
    }, (error) => {});
}

function generateWithdrawalId() { return 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }
function generateTxId() { return 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8); }
function validateBEP20Wallet(address) { return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address.trim()); }

// ============================================================
// 🔥 ATOMIC WITHDRAWAL CREATION (Bulletproof)
// ============================================================
async function createAtomicWithdrawal(userId, userData, walletAddress) {
    if (isProcessingWithdrawal) throw new Error('Withdrawal already in progress');
    isProcessingWithdrawal = true;
    let withdrawalId = null; let txId = null;

    try {
        if (getCampaignStatus() !== 'ENDED') throw new Error('Offer has not ended yet.');
        if (!isUserActive(userData)) throw new Error('Your ID is not active. Please activate your account.');
        if (!validateBEP20Wallet(walletAddress)) throw new Error('Invalid BEP-20 wallet address.');

        const campaignRef = ref(db, `campaign_rewards/${userId}/${LIVE_CAMPAIGN_ID}`);
        withdrawalId = generateWithdrawalId(); 
        txId = generateTxId(); 
        const timestamp = Date.now();

        const lockResult = await runTransaction(campaignRef, current => {
            if (!current) return;
            const currentStatus = String(current.status || '').toLowerCase();
            if (currentStatus !== 'available' && currentStatus !== 'rejected') return;
            if (current.isFinalized !== true) return;
            if (!isWithdrawalEligible(Number(current.finalDirectCount || 0))) return;
            
            const reward = Number(current.finalReward || 0);
            if (!Number.isFinite(reward) || reward <= 0) return;

            return { 
                ...current, 
                status: 'pending', 
                walletAddress: walletAddress, 
                withdrawalId: withdrawalId, 
                transactionId: txId, 
                requestedAt: timestamp, 
                updatedAt: timestamp 
            };
        });

        if (!lockResult.committed) {
            throw new Error('Withdrawal request could not be locked. Please ensure you meet all criteria (5 referrals, active ID, offer ended) and try again.');
        }
        
        const lockedCampaign = lockResult.snapshot.val();
        if (!lockedCampaign || lockedCampaign.withdrawalId !== withdrawalId) {
            throw new Error('Security Error: Withdrawal request mismatch. Please contact support.');
        }

        const finalReward = Number(lockedCampaign.finalReward || 0);
        if (finalReward <= 0) throw new Error('No eligible reward found.');

        const date = new Date(timestamp).toISOString().split('T')[0];
        const dynamicName = CAMPAIGN.campaignName;

        const adminData = { 
            ...lockedCampaign, 
            campaignName: dynamicName, 
            campaignId: LIVE_CAMPAIGN_ID, 
            type: 'direct_offer_50pack_withdrawal', 
            asset: 'USDT', 
            network: 'BEP-20 / BNB Smart Chain', 
            amount: finalReward, 
            status: 'pending' 
        };
        
        const transactionData = { 
            type: 'direct_offer_50pack_withdrawal', 
            subtype: `${dynamicName} Withdrawal`, 
            amount: finalReward, 
            currency: 'USDT', 
            network: 'BEP-20 / BNB Smart Chain', 
            status: 'pending', 
            walletAddress: walletAddress, 
            withdrawalId: withdrawalId, 
            timestamp: timestamp, 
            date: date, 
            description: `${dynamicName} Withdrawal of $${finalReward} USDT (BEP-20)`, 
            txId: txId, 
            txHash: null 
        };
        
        const globalTxData = { 
            ...transactionData, 
            userId: userId, 
            username: userData.username || userData.referralCode || userId 
        };

        try {
            await update(ref(db), {
                [`admin/withdrawals/${withdrawalId}`]: adminData,
                [`users/${userId}/transactions/${txId}`]: transactionData,
                [`transactions/${txId}`]: globalTxData
            });
        } catch (writeError) {
            console.error("Firebase Write Error:", writeError);
            
            let adminExists = false, userTxExists = false, globalTxExists = false;
            try {
                const [a, u, g] = await Promise.all([ 
                    get(ref(db, `admin/withdrawals/${withdrawalId}`)), 
                    get(ref(db, `users/${userId}/transactions/${txId}`)), 
                    get(ref(db, `transactions/${txId}`)) 
                ]);
                adminExists = a.exists(); userTxExists = u.exists(); globalTxExists = g.exists();
            } catch (vErr) { 
                throw new Error('Network error. Please check your internet and history in a few minutes.'); 
            }

            if (adminExists && userTxExists && globalTxExists) {
                return { success: true, withdrawalId, txId };
            }
            
            await runTransaction(campaignRef, current => {
                if (current && current.status === 'pending' && current.withdrawalId === withdrawalId) {
                    return { ...current, status: 'available', walletAddress: null, withdrawalId: null, transactionId: null, requestedAt: null, updatedAt: Date.now() };
                }
                return current;
            });
            
            throw new Error(writeError.message || 'Failed to submit withdrawal to database.');
        }
        
        return { success: true, withdrawalId, txId };
    } finally { 
        isProcessingWithdrawal = false; 
    }
}

function showToast(message, type = 'success') {
    const container = el.toastContainer; if (!container) return;
    const toast = document.createElement('div'); toast.className = `toast-custom ${type}`;
    const iconMap = { success: 'bi-check-circle-fill text-success', error: 'bi-exclamation-triangle-fill text-danger', warning: 'bi-exclamation-triangle-fill text-warning', info: 'bi-info-circle-fill text-info' };
    toast.innerHTML = `<i class="bi ${iconMap[type] || iconMap.success}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 5000);
}

function renderCycleProgress(directCount) {
    const grid = el.cycleProgressGrid; if (!grid || !CAMPAIGN) return;
    grid.innerHTML = '';
    const count = Math.max(0, Number(directCount) || 0);
    const totalCycles = Math.max(1, Math.ceil(count / CAMPAIGN.cycleSize) + 1);
    let foundNext = false;

    for (let i = 1; i <= totalCycles; i++) {
        const cycleEnd = i * CAMPAIGN.cycleSize; const cycleReward = i * CAMPAIGN.cycleReward;
        const achieved = count >= cycleEnd; const isNext = !achieved && !foundNext; if (isNext) foundNext = true;
        let statusClass = achieved ? 'achieved' : (isNext ? 'next' : 'locked');
        let statusText = achieved ? '✓ Complete' : (isNext ? 'Current' : 'Locked');
        const card = document.createElement('div'); card.className = `cycle-card ${statusClass}`;
        card.innerHTML = `<div class="cycle-label">Cycle ${i}</div><div class="cycle-refs">${cycleEnd}<small>refs</small></div><div class="cycle-reward">$${cycleReward}</div><span class="cycle-status ${statusClass}">${statusText}</span>`;
        grid.appendChild(card);
    }
}

function updateWithdrawalUI(reward, status) {
    if (!CAMPAIGN) return;
    const campaignStatus = getCampaignStatus();
    let effectiveCount = Number(directReferrals) || 0;
    if (campaignStatus === 'ENDED' && campaignRewardSnapshot) effectiveCount = Number(campaignRewardSnapshot.finalDirectCount || 0);

    const meetsMin = isWithdrawalEligible(effectiveCount);
    const hasReward = Number(reward) > 0;
    const isEligible = meetsMin && hasReward;
    const isWithdrawn = !!status && ['pending', 'approved', 'paid'].includes(String(status.status || '').toLowerCase());
    
    let displayReward = reward;
    if (campaignStatus === 'ENDED' && campaignRewardSnapshot) displayReward = Number(campaignRewardSnapshot.finalReward ?? 0);
    
    if (el.withdrawAmount) el.withdrawAmount.textContent = '$' + displayReward.toFixed(2) + ' USDT';
    if (el.walletFormGroup) el.walletFormGroup.style.display = (campaignStatus === 'ENDED' && isEligible && !isWithdrawn) ? 'block' : 'none';
    if (el.withdrawalInfoBox) el.withdrawalInfoBox.style.display = 'block';

    if (status) {
        const norm = String(status.status || '').toLowerCase();
        if (el.withdrawBtn) el.withdrawBtn.disabled = true;
        if (norm === 'pending') {
            if (el.withdrawBtn) { el.withdrawBtn.innerHTML = '<i class="bi bi-clock me-2"></i>Pending Approval'; el.withdrawBtn.className = 'btn-withdraw btn-pending'; }
            if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = '⏳ Your withdrawal request is pending admin approval.';
            if (el.withdrawalStatus) { el.withdrawalStatus.className = 'withdrawal-status visible pending'; el.withdrawalStatus.textContent = 'Your withdrawal request is under admin review.'; }
            if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
            if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = 'Withdrawal pending approval';
        } else if (norm === 'approved') {
            if (el.withdrawBtn) { el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Approved'; el.withdrawBtn.className = 'btn-withdraw btn-approved'; }
            if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = '✅ Your withdrawal has been approved and is being processed.';
            if (el.withdrawalStatus) { el.withdrawalStatus.className = 'withdrawal-status visible approved'; el.withdrawalStatus.textContent = 'Your withdrawal has been approved and is being processed.'; }
            if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
            if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = 'Withdrawal approved - processing payment';
        } else if (norm === 'paid') {
            if (el.withdrawBtn) { el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle-fill me-2"></i>Paid ✓'; el.withdrawBtn.className = 'btn-withdraw btn-paid'; }
            if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = '✅ Payment completed successfully!';
            if (el.withdrawalStatus) { el.withdrawalStatus.className = 'withdrawal-status visible paid'; el.withdrawalStatus.textContent = 'Payment has been sent to your wallet.'; }
            if (el.withdrawalDetails) el.withdrawalDetails.classList.add('visible');
            if (el.detailAmount) el.detailAmount.textContent = '$' + (status.finalReward || displayReward).toFixed(2) + ' USDT';
            if (el.detailWallet) el.detailWallet.textContent = status.walletAddress || '---';
            if (el.detailPaidDate) el.detailPaidDate.textContent = status.paidAt ? new Date(status.paidAt).toLocaleString() : '---';
            if (el.detailTxHash) el.detailTxHash.textContent = status.txHash || 'Pending';
            if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = '✅ Payment Completed';
        } else if (norm === 'rejected') {
            if (el.withdrawBtn) { el.withdrawBtn.disabled = false; el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward'; el.withdrawBtn.className = 'btn-withdraw btn-rejected'; }
            if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = '⚠️ Your previous request was rejected. You can try again.';
            if (el.withdrawalStatus) { el.withdrawalStatus.className = 'withdrawal-status visible rejected'; el.withdrawalStatus.textContent = 'Your request was rejected. Please check your wallet address and try again.'; }
            if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
            if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = 'Request rejected - try again';
        }
        return;
    }

    if (campaignStatus === 'UPCOMING') {
        if (el.withdrawBtn) { el.withdrawBtn.disabled = true; el.withdrawBtn.innerHTML = '⏳ Withdrawal Opens After Offer Ends'; el.withdrawBtn.className = 'btn-withdraw withdrawal-locked'; }
        if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = `📅 Campaign starts on ${CAMPAIGN.startDate.toLocaleDateString()}. Withdrawal will be available after ${CAMPAIGN.endDate.toLocaleDateString()}. Time until start: ${formatTimeRemaining(getTimeRemaining())}`;
        if (el.withdrawalStatus) el.withdrawalStatus.classList.remove('visible');
        if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
        if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = 'Withdrawal not available yet';
    } else if (campaignStatus === 'ACTIVE') {
        if (el.withdrawBtn) { el.withdrawBtn.disabled = true; el.withdrawBtn.innerHTML = '🔒 Withdrawal Locked — Offer Active'; el.withdrawBtn.className = 'btn-withdraw withdrawal-locked'; }
        if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = `🔒 Withdrawal is locked while the offer is active. It will open after ${CAMPAIGN.endDate.toLocaleDateString()}. Time remaining: ${formatTimeRemaining(getTimeRemaining())}`;
        if (el.withdrawalStatus) el.withdrawalStatus.classList.remove('visible');
        if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
        if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = 'Withdrawal locked - offer active';
    } else if (campaignStatus === 'ENDED') {
        if (isEligible) {
            if (el.withdrawBtn) { el.withdrawBtn.disabled = false; el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward'; el.withdrawBtn.className = 'btn-withdraw'; }
            if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = '🎉 Offer ended! You are eligible to withdraw your reward.';
            if (el.withdrawalStatus) el.withdrawalStatus.classList.remove('visible');
            if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
            if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = 'Withdrawal available - claim your reward!';
        } else if (hasReward && !meetsMin) {
            const needed = Math.max(0, CAMPAIGN.minReferralsForWithdrawal - effectiveCount);
            if (el.withdrawBtn) { el.withdrawBtn.disabled = true; el.withdrawBtn.innerHTML = `⛔ Minimum ${CAMPAIGN.minReferralsForWithdrawal} Referrals Required`; el.withdrawBtn.className = 'btn-withdraw withdrawal-locked'; }
            if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = `⛔ Minimum ${CAMPAIGN.minReferralsForWithdrawal} qualified direct referrals required. You have ${effectiveCount}. Need ${needed} more.`;
            if (el.withdrawalStatus) el.withdrawalStatus.classList.remove('visible');
            if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
            if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = `Need ${needed} more referral${needed === 1 ? '' : 's'} to withdraw`;
        } else {
            if (el.withdrawBtn) { el.withdrawBtn.disabled = true; el.withdrawBtn.innerHTML = '⛔ Not Eligible'; el.withdrawBtn.className = 'btn-withdraw withdrawal-locked'; }
            if (el.withdrawalInfoText) el.withdrawalInfoText.textContent = `Complete at least ${CAMPAIGN.minReferralsForWithdrawal} qualified referrals ($${CAMPAIGN.minReferralsForWithdrawal * CAMPAIGN.rewardPerReferral}) to be eligible.`;
            if (el.withdrawalStatus) el.withdrawalStatus.classList.remove('visible');
            if (el.withdrawalDetails) el.withdrawalDetails.classList.remove('visible');
            if (el.withdrawalSubtitle) el.withdrawalSubtitle.textContent = 'Not eligible for withdrawal';
        }
    }
}

async function refreshCampaignDirectCount() {
    if (!currentUserId || getCampaignStatus() !== 'ACTIVE' || isWithdrawalFinalized || !CAMPAIGN) return;
    try {
        const latest = Math.max(0, Number(await getCampaignDirectReferrals(currentUserId)) || 0);
        if (latest !== directReferrals) { directReferrals = latest; if (el.totalReferralsDisplay) el.totalReferralsDisplay.textContent = String(latest); updateUI(); }
    } catch (e) {}
}
function startReferralRefresh() {
    if (referralRefreshInterval) clearInterval(referralRefreshInterval);
    if (!currentUserId || getCampaignStatus() !== 'ACTIVE' || isWithdrawalFinalized) return;
    referralRefreshInterval = setInterval(() => {
        if (!currentUserId || getCampaignStatus() !== 'ACTIVE' || isWithdrawalFinalized) { clearInterval(referralRefreshInterval); referralRefreshInterval = null; return; }
        refreshCampaignDirectCount();
    }, 60000);
}

function updateUI() {
    if (!CAMPAIGN) return;
    const campaignStatus = getCampaignStatus();
    const startStr = CAMPAIGN.startDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const endStr = CAMPAIGN.endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    const statusBadge = {
        'UPCOMING': { class: 'upcoming', text: `⏳ Upcoming - Starts ${startStr}` },
        'ACTIVE': { class: 'active', text: `🔥 ACTIVE - Refer & Earn $${CAMPAIGN.rewardPerReferral} per Referral!` },
        'ENDED': { class: 'ended', text: '🏁 Offer Ended - Withdrawal Available' }
    }[campaignStatus] || { class: 'upcoming', text: '⏳ Loading...' };

    if (el.campaignStatusBadge) el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge ${statusBadge.class}">${statusBadge.text}</span>`;

    let displayReward = calculateReward(directReferrals);
    let displayDirectCount = directReferrals;
    let isFinal = false;

    if (campaignStatus === 'ENDED' && campaignRewardSnapshot) {
        displayReward = Number(campaignRewardSnapshot.finalReward ?? 0);
        displayDirectCount = Number(campaignRewardSnapshot.finalDirectCount ?? 0);
        isFinal = true; isWithdrawalFinalized = true;
    }

    if (el.statDirectRefs) el.statDirectRefs.textContent = displayDirectCount;
    if (el.statEligibleReward) el.statEligibleReward.textContent = '$' + displayReward;
    if (el.statReferralPeriod) el.statReferralPeriod.textContent = campaignStatus === 'ENDED' ? 'Final Count' : 'Campaign Period';

    if (el.statRewardNote) {
        if (displayDirectCount > 0) {
            const cycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize);
            el.statRewardNote.textContent = isFinal ? `🏆 Final: $${displayReward} (${displayDirectCount} refs)` : `💰 $${displayReward} earned (${displayDirectCount} refs)${cycles > 0 ? ' • ' + cycles + ' cycle(s)' : ''}`;
            el.statRewardNote.style.color = '#fbbf24';
        } else {
            el.statRewardNote.textContent = `Earn $${CAMPAIGN.rewardPerReferral} per qualified $${CAMPAIGN.requiredPackageAmount}+ package referral`;
            el.statRewardNote.style.color = '#64748b';
        }
    }

    const completedCycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize);
    const nextCycleEnd = (completedCycles + 1) * CAMPAIGN.cycleSize;
    const nextMilestoneReward = (completedCycles + 1) * CAMPAIGN.cycleReward;
    if (el.statNextMilestone) el.statNextMilestone.textContent = `${nextCycleEnd} → $${nextMilestoneReward}`;
    if (el.statNextMilestoneSub) el.statNextMilestoneSub.textContent = `${Math.max(0, nextCycleEnd - displayDirectCount)} more needed`;
    if (el.statMaxReward) { el.statMaxReward.textContent = '∞'; el.statMaxReward.style.color = '#a78bfa'; }

    const cycleProgress = getCurrentCycleProgress(displayDirectCount);
    if (el.progressCurrent) el.progressCurrent.textContent = String(cycleProgress);
    if (el.progressTarget) el.progressTarget.textContent = String(CAMPAIGN.cycleSize);
    if (el.progressFill) el.progressFill.style.width = Math.min(100, Math.max(0, (cycleProgress / CAMPAIGN.cycleSize) * 100)) + '%';

    const neededForCycle = Math.max(0, CAMPAIGN.cycleSize - cycleProgress);
    if (cycleProgress === CAMPAIGN.cycleSize) {
        if (el.needMore) el.needMore.textContent = '0';
        if (el.nextMilestoneText) el.nextMilestoneText.innerHTML = '<i class="bi bi-trophy" style="color:#fbbf24;"></i> 🎉 Cycle complete! Start next by referring more.';
    } else {
        if (el.needMore) el.needMore.textContent = String(neededForCycle);
        if (el.nextMilestoneText) el.nextMilestoneText.innerHTML = `<i class="bi bi-bullseye" style="color:#fbbf24;"></i> Need <strong>${neededForCycle}</strong> more to complete this $${CAMPAIGN.cycleReward} cycle.`;
    }

    renderCycleProgress(displayDirectCount);

    if (el.notEligibleBox) { if (displayDirectCount === 0) el.notEligibleBox.classList.add('visible'); else el.notEligibleBox.classList.remove('visible'); }
    if (el.walletAmount) el.walletAmount.textContent = displayReward.toFixed(2);

    if (isFinal) {
        if (el.finalBadge) el.finalBadge.style.display = 'inline';
        if (el.walletLabel) el.walletLabel.textContent = 'Final Offer Earnings';
        if (el.walletStatusText) el.walletStatusText.textContent = displayReward > 0 ? `🏆 Final earnings locked! $${displayReward} from ${displayDirectCount} refs.` : 'No reward earned.';
    } else {
        if (el.finalBadge) el.finalBadge.style.display = 'none';
        if (el.walletLabel) el.walletLabel.textContent = 'Estimated Offer Earnings';
        if (el.walletStatusText) {
            if (displayReward === 0) el.walletStatusText.textContent = `💡 Refer users who activate $${CAMPAIGN.requiredPackageAmount}+ package to earn $${CAMPAIGN.rewardPerReferral} each!`;
            else {
                const cycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize); const rem = displayDirectCount % CAMPAIGN.cycleSize;
                if (rem === 0 && cycles > 0) el.walletStatusText.textContent = `💰 $${displayReward} earned! ${cycles} cycle(s) completed.`;
                else el.walletStatusText.textContent = `💰 $${displayReward} estimated! ${CAMPAIGN.cycleSize - rem} more to complete cycle.`;
            }
        }
    }
    updateWithdrawalUI(displayReward, withdrawalData);
}

function showDaysPopup() {
    if (!CAMPAIGN) return;
    const campaignStatus = getCampaignStatus();
    const reward = calculateReward(directReferrals);
    const time = getTimeRemaining();
    const startStr = CAMPAIGN.startDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const endStr = CAMPAIGN.endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

    if (campaignStatus === 'UPCOMING') {
        if (el.popupIcon) el.popupIcon.textContent = '📅';
        if (el.popupTitle) el.popupTitle.textContent = 'Offer Not Started Yet';
        if (el.popupText) el.popupText.innerHTML = `The ${CAMPAIGN.campaignName} has not started yet.<br><br><strong>Starts:</strong> ${startStr}<br><strong>Ends:</strong> ${endStr}<br><strong>Your Est. Reward:</strong> $${reward.toFixed(2)} USDT<br><br><span style="color:#94a3b8;font-size:0.9rem;">Time until start:</span><div class="popup-days">${time.days}d ${time.hours}h ${time.minutes}m</div>`;
    } else if (campaignStatus === 'ACTIVE') {
        if (el.popupIcon) el.popupIcon.textContent = '🔒';
        if (el.popupTitle) el.popupTitle.textContent = 'Withdrawal Locked — Offer Active';
        if (el.popupText) el.popupText.innerHTML = `🔒 Your reward is locked.<br><br><strong>Est. Reward:</strong> $${reward.toFixed(2)} USDT<br><strong>Ends:</strong> ${endStr} at 23:59:59 IST<br><strong>Opens:</strong> After end time<br><br><span style="color:#94a3b8;font-size:0.9rem;">Time Remaining:</span><div class="popup-days">${formatTimeRemaining(time)}</div>`;
    } else if (campaignStatus === 'ENDED') {
        const finalReward = campaignRewardSnapshot ? Number(campaignRewardSnapshot.finalReward ?? 0) : reward;
        const finalCount = campaignRewardSnapshot ? Number(campaignRewardSnapshot.finalDirectCount ?? 0) : Number(directReferrals) || 0;
        if (finalReward > 0 && isWithdrawalEligible(finalCount)) {
            if (el.popupIcon) el.popupIcon.textContent = '🎉';
            if (el.popupTitle) el.popupTitle.textContent = 'Offer Ended!';
            if (el.popupText) el.popupText.innerHTML = `Withdrawal is now available.<br><br><strong>Eligible Reward:</strong> $${finalReward.toFixed(2)} USDT<br><strong>Qualified Ref:</strong> ${finalCount}<br><br>Click <strong>"Withdraw Reward"</strong>.`;
        } else if (finalReward > 0 && !isWithdrawalEligible(finalCount)) {
            const needed = Math.max(0, CAMPAIGN.minReferralsForWithdrawal - finalCount);
            if (el.popupIcon) el.popupIcon.textContent = '⛔';
            if (el.popupTitle) el.popupTitle.textContent = `Minimum ${CAMPAIGN.minReferralsForWithdrawal} Referrals Required`;
            if (el.popupText) el.popupText.innerHTML = `आपके पास अभी <strong>${finalCount}</strong> qualified referral हैं।<br><br>Withdrawal के लिए <strong>${CAMPAIGN.minReferralsForWithdrawal}</strong> ज़रूरी हैं।<br>और <strong>${needed}</strong> चाहिए।<br><br><span style="color:#94a3b8;font-size:0.85rem;">आपका reward ($${finalReward.toFixed(2)}) safe है, लेकिन referrals पूरे होने तक unlock नहीं होगा।</span>`;
        } else {
            if (el.popupIcon) el.popupIcon.textContent = '⛔';
            if (el.popupTitle) el.popupTitle.textContent = 'Not Eligible';
            if (el.popupText) el.popupText.innerHTML = `You have 0 qualified referrals.<br><br><strong>Minimum required:</strong> ${CAMPAIGN.minReferralsForWithdrawal} Qualified Referrals ($${CAMPAIGN.requiredPackageAmount}+ package)<br><strong>Yours:</strong> ${finalCount}`;
        }
    }
    if (el.daysPopup) el.daysPopup.classList.add('visible');
}

function handleWithdrawClick() {
    if (!CAMPAIGN) return;
    if (getCampaignStatus() !== 'ENDED') { showDaysPopup(); return; }
    let reward = campaignRewardSnapshot ? Number(campaignRewardSnapshot.finalReward || 0) : calculateReward(directReferrals);
    let finalCount = campaignRewardSnapshot ? Number(campaignRewardSnapshot.finalDirectCount || 0) : Number(directReferrals) || 0;

    if (!isWithdrawalEligible(finalCount)) { showToast(`Minimum ${CAMPAIGN.minReferralsForWithdrawal} required. You have ${finalCount}.`, 'warning'); showDaysPopup(); return; }
    if (!Number.isFinite(reward) || reward <= 0) { showDaysPopup(); return; }
    if (withdrawalData && ['pending', 'approved', 'paid'].includes(String(withdrawalData.status || '').toLowerCase())) { showToast('Already submitted.', 'warning'); return; }

    const addr = el.walletAddressInput ? el.walletAddressInput.value.trim() : '';
    if (!validateBEP20Wallet(addr)) { showToast('Enter valid BEP-20 address (0x...).', 'error'); if (el.walletAddressInput) el.walletAddressInput.classList.add('error'); return; }

    if (el.confirmAmount) el.confirmAmount.textContent = '$' + Number(reward).toFixed(2) + ' USDT';
    if (el.confirmWallet) el.confirmWallet.textContent = addr;
    if (el.confirmationModal) el.confirmationModal.classList.add('visible');
}

async function processWithdrawal() {
    if (isProcessingWithdrawal || !CAMPAIGN) return;
    const origHTML = '<i class="bi bi-check-circle me-1"></i>Confirm Withdrawal';
    
    if (el.confirmSubmit) { 
        el.confirmSubmit.disabled = true; 
        el.confirmSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...'; 
    }

    try {
        const user = auth.currentUser;
        if (!user || user.uid !== currentUserId) {
            throw new Error("Session expired. Please refresh the page and login again.");
        }

        const addr = el.walletAddressInput ? el.walletAddressInput.value.trim() : '';
        if (!validateBEP20Wallet(addr)) { throw new Error('Please enter a valid BEP-20 wallet address (0x...).'); }
        if (getCampaignStatus() !== 'ENDED') { throw new Error('You cannot withdraw until the offer has ended.'); }

        const userSnap = await get(ref(db, 'users/' + currentUserId));
        if (!userSnap.exists()) { throw new Error('User data not found in database.'); }
        const latestData = userSnap.val();
        
        if (!isUserActive(latestData)) { throw new Error('Your ID is not active. You must have a valid $50+ package.'); }

        let snapshot = await getCampaignRewardSnapshot(currentUserId);
        if (!snapshot) {
            snapshot = await finalizeCampaignReward(currentUserId);
        }
        if (!snapshot) { throw new Error('Reward record not found. Please refresh the page.'); }
        if (!snapshot.isFinalized) { throw new Error('Your reward is not finalized yet.'); }

        const finalCount = Number(snapshot.finalDirectCount || 0);
        const finalReward = Number(snapshot.finalReward || 0);
        
        if (finalCount < CAMPAIGN.minReferralsForWithdrawal) {
            throw new Error(`You need at least ${CAMPAIGN.minReferralsForWithdrawal} referrals. You have ${finalCount}.`);
        }
        if (finalReward <= 0) {
            throw new Error('Your eligible reward is $0.00. Please contact support.');
        }
        
        if (withdrawalData && ['pending', 'approved', 'paid'].includes(String(withdrawalData.status || '').toLowerCase())) { 
            throw new Error('You have already submitted a withdrawal request. Please wait for admin approval.'); 
        }

        const result = await createAtomicWithdrawal(currentUserId, latestData, addr);
        
        if (result.success) {
            showToast('✅ Withdrawal submitted successfully! Awaiting admin approval.', 'success');
            withdrawalData = await checkWithdrawalStatus(currentUserId);
            if (el.walletAddressInput) el.walletAddressInput.value = '';
            if (el.confirmationModal) el.confirmationModal.classList.remove('visible');
            updateUI();
        } else { 
            throw new Error('Failed to submit withdrawal. Please try again.'); 
        }
    } catch (e) { 
        console.error("Withdrawal Error:", e);
        showToast('❌ ' + (e.message || 'An error occurred while submitting.'), 'error'); 
    }
    finally {
        isProcessingWithdrawal = false;
        if (el.confirmSubmit) { 
            el.confirmSubmit.disabled = false; 
            el.confirmSubmit.innerHTML = origHTML; 
        }
    }
}

async function loadUserData(user) {
    try {
        if (!user || !user.uid) { showToast('Session error.', 'error'); return; }
        currentUserId = user.uid;
        const snap = await get(ref(db, 'users/' + user.uid));
        if (!snap.exists()) { showToast('Complete registration.', 'error'); return; }
        currentUserData = snap.val();
        const name = currentUserData.name || currentUserData.username || 'User';
        if (el.userName) el.userName.textContent = name;
        if (el.userAvatar) el.userAvatar.textContent = name.charAt(0).toUpperCase();

        campaignRewardSnapshot = await getCampaignRewardSnapshot(user.uid);
        isWithdrawalFinalized = campaignRewardSnapshot?.isFinalized === true;

        if (isUserActive(currentUserData)) {
            directReferrals = await getCampaignDirectReferrals(user.uid);
        } else {
            directReferrals = 0;
        }

        if (getCampaignStatus() === 'ENDED') {
            if (!campaignRewardSnapshot) {
                campaignRewardSnapshot = await finalizeCampaignReward(user.uid);
            }
            if (campaignRewardSnapshot) {
                isWithdrawalFinalized = true;
                directReferrals = Number(campaignRewardSnapshot.finalDirectCount || 0);
            }
        }

        setupWithdrawalListener(user.uid);
        withdrawalData = await checkWithdrawalStatus(user.uid);

        const refCode = currentUserData.referralCode || user.uid.substring(0, 8).toUpperCase();
        if (el.referralLinkDisplay) el.referralLinkDisplay.textContent = `https://staking.randigital.in/register.html?ref=${refCode}`;
        if (el.referralCodeDisplay) el.referralCodeDisplay.textContent = refCode;
        if (el.totalReferralsDisplay) el.totalReferralsDisplay.textContent = directReferrals;

        startCountdown(); updateUI();

        const status = getCampaignStatus();
        if (status === 'UPCOMING') showToast(`📢 Starts on ${CAMPAIGN.startDate.toLocaleDateString()}!`, 'warning');
        else if (status === 'ACTIVE') {
            if (isUserActive(currentUserData)) { showToast(`🎯 ACTIVE! Earn $${CAMPAIGN.rewardPerReferral}/ref!`, 'success'); startReferralRefresh(); }
            else showToast(`ℹ️ Activate $${CAMPAIGN.requiredPackageAmount}+ package to join.`, 'info');
        } else if (status === 'ENDED') {
            if (directReferrals > 0) showToast('🏆 Eligible for withdrawal.', 'success');
            else showToast(`⏰ Need at least 1 ref.`, 'warning');
        }
    } catch (e) { showToast('Error: ' + (e.message || 'Unknown'), 'error'); }
    finally { if (el.loadingOverlay) el.loadingOverlay.classList.add('hidden'); }
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    function update() {
        if (!CAMPAIGN) return;
        const time = getTimeRemaining(); const status = getCampaignStatus();
        if (status === 'ENDED') {
            if (el.countdownWrapper) el.countdownWrapper.style.display = 'none';
            if (el.campaignEndedMessage) el.campaignEndedMessage.style.display = 'block';
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
            if (referralRefreshInterval) { clearInterval(referralRefreshInterval); referralRefreshInterval = null; }
            if (!isWithdrawalFinalized && currentUserId) {
                finalizeCampaignReward(currentUserId).then(s => { if (s) { campaignRewardSnapshot = s; directReferrals = Number(s.finalDirectCount || 0); isWithdrawalFinalized = true; } updateUI(); });
            }
            updateUI(); return;
        }
        if (el.countdownDays) el.countdownDays.textContent = String(time.days).padStart(2, '0');
        if (el.countdownHours) el.countdownHours.textContent = String(time.hours).padStart(2, '0');
        if (el.countdownMinutes) el.countdownMinutes.textContent = String(time.minutes).padStart(2, '0');
        if (el.countdownSeconds) el.countdownSeconds.textContent = String(time.seconds).padStart(2, '0');
    }
    update(); countdownInterval = setInterval(update, 1000);
}

function setupWalletValidation() {
    if (!el.walletAddressInput) return;
    el.walletAddressInput.addEventListener('input', () => {
        const val = el.walletAddressInput.value.trim(); const msg = el.walletValidationMsg;
        if (!msg) return;
        if (!val) { el.walletAddressInput.className = 'form-control-custom'; msg.className = 'wallet-validation-msg'; msg.textContent = ''; return; }
        if (validateBEP20Wallet(val)) { el.walletAddressInput.className = 'form-control-custom valid'; msg.className = 'wallet-validation-msg valid'; msg.textContent = '✅ Valid BEP-20 wallet'; }
        else { el.walletAddressInput.className = 'form-control-custom error'; msg.className = 'wallet-validation-msg error'; msg.textContent = '❌ Invalid BEP-20 wallet'; }
    });
}

async function copyReferralLink() {
    const link = el.referralLinkDisplay ? el.referralLinkDisplay.textContent : '';
    if (!link || link === 'Loading...') { showToast('Wait...', 'warning'); return; }
    try {
        await navigator.clipboard.writeText(link);
        if (el.copyReferralBtn) el.copyReferralBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
        showToast('✅ Copied!', 'success');
        setTimeout(() => { if (el.copyReferralBtn) el.copyReferralBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy Referral Link'; }, 3000);
    } catch {
        const ta = document.createElement('textarea'); ta.value = link; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('✅ Copied!', 'success');
        setTimeout(() => { if (el.copyReferralBtn) el.copyReferralBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy Referral Link'; }, 3000);
    }
}

async function handleLogout() { try { await signOut(auth); window.location.href = 'login.html'; } catch (e) { showToast('Logout error', 'error'); } }

function setupListeners() {
    if (listenersInitialized) return; listenersInitialized = true;
    if (el.copyReferralBtn) el.copyReferralBtn.addEventListener('click', copyReferralLink);
    if (el.logoutBtn) el.logoutBtn.addEventListener('click', handleLogout);
    if (el.withdrawBtn) el.withdrawBtn.addEventListener('click', handleWithdrawClick);
    if (el.popupCloseBtn) el.popupCloseBtn.addEventListener('click', () => { if (el.daysPopup) el.daysPopup.classList.remove('visible'); });
    if (el.daysPopup) el.daysPopup.addEventListener('click', (e) => { if (e.target === el.daysPopup) el.daysPopup.classList.remove('visible'); });
    if (el.confirmCancel) el.confirmCancel.addEventListener('click', () => { if (el.confirmationModal) el.confirmationModal.classList.remove('visible'); });
    if (el.confirmationModal) el.confirmationModal.addEventListener('click', (e) => { if (e.target === el.confirmationModal) el.confirmationModal.classList.remove('visible'); });
    if (el.confirmSubmit) el.confirmSubmit.addEventListener('click', processWithdrawal);
    setupWalletValidation();
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && currentUserId && getCampaignStatus() === 'ACTIVE' && !isWithdrawalFinalized) refreshCampaignDirectCount(); });

window.addEventListener('beforeunload', () => {
    if (countdownInterval) clearInterval(countdownInterval);
    if (referralRefreshInterval) clearInterval(referralRefreshInterval);
    if (withdrawalListenerUnsubscribe) { try { withdrawalListenerUnsubscribe(); } catch (e) {} }
    if (serverTimeListenerUnsubscribe) { try { serverTimeListenerUnsubscribe(); } catch (e) {} }
});

const AUTH_TIMEOUT_MS = 10000; 
let authResolved = false;

const authTimeoutHandle = setTimeout(() => { 
    if (!authResolved) { 
        if (el.loadingOverlay) el.loadingOverlay.classList.add('hidden'); 
        if (!auth.currentUser) window.location.href = 'login.html'; 
    } 
}, AUTH_TIMEOUT_MS);

onAuthStateChanged(auth, async (user) => {
    authResolved = true; clearTimeout(authTimeoutHandle);
    if (!user) { window.location.href = 'login.html'; return; }
    syncFirebaseServerTime(); await loadUserData(user); setupListeners();
});
