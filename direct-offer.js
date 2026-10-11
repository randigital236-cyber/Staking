// ============================================================
// RND $50+ PACKAGE DIRECT REFERRAL OFFER — FINAL PRODUCTION SCRIPT
// Campaign: direct_offer_50pack_oct2026
//
// All Fixes Applied:
//   FIX 1–21  : Original production fixes
//   FIX A     : Withdrawal write failure — verify before rollback
//   FIX B     : Active campaign — button truly disabled
//   FIX C     : processWithdrawal — entry-level UI lock + finally restore
//   FIX 1 (new) : Prevent duplicate Firebase onValue() listeners
//   FIX 2 (new) : Correct isWithdrawalFinalized state
//   FIX 3 (new) : Clean up Firebase listener on page unload
//   FIX (amount) : $50-or-more packages now qualify
//   FIX (time)   : Server time offset via onValue(), non-blocking
//   FIX (load)   : Loading overlay guaranteed close
// ============================================================

// ============================================================
// FIREBASE IMPORTS
// ============================================================
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, update, onValue, runTransaction } from "firebase/database";

// ============================================================
// FIREBASE CONFIG (rnd2-70080)
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// CAMPAIGN CONFIGURATION
// requiredPackageAmount: 50 = MINIMUM qualifying amount
// ============================================================
const CAMPAIGN = {
    campaignId: 'direct_offer_50pack_oct2026',
    startDate: new Date('2026-10-10T00:00:00+05:30'),
    endDate: new Date('2026-10-24T23:59:59+05:30'),
    requiredPackageAmount: 50,
    rewardPerReferral: 10,
    cycleSize: 5,
    cycleReward: 50,
    maxQualifying: Infinity
};

// ============================================================
// DOM REFS
// ============================================================
const $ = id => document.getElementById(id);
const el = {
    loadingOverlay: $('loadingOverlay'),
    toastContainer: $('toastContainer'),
    userAvatar: $('userAvatar'),
    userName: $('userName'),
    logoutBtn: $('logoutBtn'),
    countdownDays: $('countdownDays'),
    countdownHours: $('countdownHours'),
    countdownMinutes: $('countdownMinutes'),
    countdownSeconds: $('countdownSeconds'),
    countdownWrapper: $('countdownWrapper'),
    campaignEndedMessage: $('campaignEndedMessage'),
    campaignStatusBadge: $('campaignStatusBadge'),
    statDirectRefs: $('statDirectRefs'),
    statReferralPeriod: $('statReferralPeriod'),
    statEligibleReward: $('statEligibleReward'),
    statRewardNote: $('statRewardNote'),
    statNextMilestone: $('statNextMilestone'),
    statNextMilestoneSub: $('statNextMilestoneSub'),
    statMaxReward: $('statMaxReward'),
    progressCurrent: $('progressCurrent'),
    progressTarget: $('progressTarget'),
    progressFill: $('progressFill'),
    needMore: $('needMore'),
    nextMilestoneText: $('nextMilestoneText'),
    cycleProgressGrid: $('cycleProgressGrid'),
    referralLinkDisplay: $('referralLinkDisplay'),
    copyReferralBtn: $('copyReferralBtn'),
    totalReferralsDisplay: $('totalReferralsDisplay'),
    referralCodeDisplay: $('referralCodeDisplay'),
    withdrawalSection: $('withdrawalSection'),
    withdrawAmount: $('withdrawAmount'),
    walletAddressInput: $('walletAddressInput'),
    walletValidationMsg: $('walletValidationMsg'),
    walletFormGroup: $('walletFormGroup'),
    withdrawBtn: $('withdrawBtn'),
    withdrawalStatus: $('withdrawalStatus'),
    withdrawalInfoBox: $('withdrawalInfoBox'),
    withdrawalInfoText: $('withdrawalInfoText'),
    withdrawalDetails: $('withdrawalDetails'),
    detailAmount: $('detailAmount'),
    detailWallet: $('detailWallet'),
    detailPaidDate: $('detailPaidDate'),
    detailTxHash: $('detailTxHash'),
    withdrawalSubtitle: $('withdrawalSubtitle'),
    notEligibleBox: $('notEligibleBox'),
    walletAmount: $('walletAmount'),
    walletLabel: $('walletLabel'),
    walletStatusText: $('walletStatusText'),
    finalBadge: $('finalBadge'),
    rewardWalletCard: $('rewardWalletCard'),
    daysPopup: $('daysPopup'),
    popupIcon: $('popupIcon'),
    popupTitle: $('popupTitle'),
    popupText: $('popupText'),
    popupRewardAmount: $('popupRewardAmount'),
    popupDaysRemaining: $('popupDaysRemaining'),
    popupCloseBtn: $('popupCloseBtn'),
    confirmationModal: $('confirmationModal'),
    confirmAmount: $('confirmAmount'),
    confirmWallet: $('confirmWallet'),
    confirmCancel: $('confirmCancel'),
    confirmSubmit: $('confirmSubmit')
};

// ============================================================
// GLOBAL STATE
// ============================================================
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

// ============================================================
// FIREBASE SERVER TIME SYNC — FIXED
// ============================================================
// समस्या: ref(db, '.info/serverTimeOffset') कुछ SDK संस्करणों में
// "Invalid token in path" error देता है जब get() से पढ़ा जाए।
//
// समाधान:
//   1. onValue() का उपयोग करें — यह special virtual path के लिए
//      सही API है
//   2. Non-blocking रखें — page load को न रोके
//   3. Offset fail होने पर 0 (client time) पर fallback
//   4. कभी भी loading overlay को block न करे
// ============================================================
function syncFirebaseServerTime() {
    // पहले से कोई listener हो तो हटाएँ
    if (serverTimeListenerUnsubscribe) {
        try {
            serverTimeListenerUnsubscribe();
        } catch (e) {
            console.warn('Error unsubscribing old server time listener:', e);
        }
        serverTimeListenerUnsubscribe = null;
    }

    try {
        const offsetRef = ref(db, '.info/serverTimeOffset');

        serverTimeListenerUnsubscribe = onValue(
            offsetRef,
            (snapshot) => {
                const raw = snapshot.val();
                const offset = Number(raw || 0);
                firebaseServerOffset = Number.isFinite(offset) ? offset : 0;

                // Offset मिलते ही countdown और UI update करें
                if (typeof updateUI === 'function') {
                    try {
                        updateUI();
                    } catch (e) {
                        console.warn('updateUI after server-time sync failed:', e);
                    }
                }
            },
            (error) => {
                console.warn(
                    'Firebase server time offset unavailable. Using client time as fallback.',
                    error?.message || error
                );
                firebaseServerOffset = 0;
            }
        );
    } catch (error) {
        console.warn(
            'Could not attach Firebase server time listener. Using client time as fallback.',
            error?.message || error
        );
        firebaseServerOffset = 0;
    }
}

function getCampaignNow() {
    return new Date(Date.now() + firebaseServerOffset);
}

// ============================================================
// ACTIVE USER CHECK
// ============================================================
function isUserActive(userData) {
    if (!userData || typeof userData !== 'object') {
        return false;
    }

    const packages = userData.packages || {};

    for (const packageId of Object.keys(packages)) {
        const pkg = packages[packageId];
        if (!pkg || typeof pkg !== 'object') continue;
        if (String(pkg.status || '').toLowerCase() === 'active' && Number(pkg.usdtAmount || 0) > 0) {
            return true;
        }
    }

    return false;
}

// ============================================================
// NORMALIZE TIMESTAMP
// ============================================================
function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (/^\d+$/.test(String(value))) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ============================================================
// PACKAGE ACTIVATION TIME
// ============================================================
function getPackageActivationTime(pkg) {
    if (!pkg || typeof pkg !== 'object') {
        return null;
    }

    const activationFields = [pkg.activationAt, pkg.activatedAt, pkg.activeAt];

    for (const value of activationFields) {
        const ts = normalizeTimestamp(value);
        if (ts) return ts;
    }

    if (String(pkg.status || '').toLowerCase() === 'active') {
        const purchaseTime = normalizeTimestamp(pkg.purchaseDate) || normalizeTimestamp(pkg.createdAt);
        return purchaseTime;
    }

    return null;
}

// ============================================================
// CAMPAIGN ELIGIBLE ACTIVE PACKAGE CHECK
// $50 OR MORE qualifies (was: exact $50 only)
// ============================================================
function hasCampaignActivePackage(userData) {
    if (!isUserActive(userData)) {
        return false;
    }

    const packages = userData.packages || {};

    for (const packageId of Object.keys(packages)) {
        const pkg = packages[packageId];
        if (!pkg || typeof pkg !== 'object') continue;

        if (String(pkg.status || '').toLowerCase() !== 'active') continue;

        const pkgAmount = Number(pkg.usdtAmount || 0);

        // $50 या उससे अधिक का सक्रिय पैकेज योग्य होगा।
        if (!Number.isFinite(pkgAmount) || pkgAmount < CAMPAIGN.requiredPackageAmount) {
            continue;
        }

        const activationTime = getPackageActivationTime(pkg);
        if (!activationTime) continue;

        if (activationTime >= CAMPAIGN.startDate.getTime() && activationTime <= CAMPAIGN.endDate.getTime()) {
            return true;
        }
    }

    return false;
}

// ============================================================
// GET CAMPAIGN DIRECT REFERRALS
// ============================================================
async function getCampaignDirectReferrals(userId) {
    try {
        if (!db || !userId) return 0;

        const ownerSnap = await get(ref(db, 'users/' + userId));
        if (!ownerSnap.exists()) return 0;

        const owner = ownerSnap.val();
        if (!isUserActive(owner)) return 0;

        const usersSnap = await get(ref(db, 'users'));
        if (!usersSnap.exists()) return 0;

        const users = usersSnap.val() || {};
        const counted = new Set();

        for (const [candidateUid, candidate] of Object.entries(users)) {
            if (!candidate || typeof candidate !== 'object' || candidateUid === userId) continue;

            let isDirect = false;

            if (candidate.sponsorUid && String(candidate.sponsorUid) === String(userId)) {
                isDirect = true;
            }

            if (!isDirect && candidate.referredByUid && String(candidate.referredByUid) === String(userId)) {
                isDirect = true;
            }

            if (!isDirect) {
                const legacySponsor = candidate.referredBy || candidate.sponsor || null;
                if (legacySponsor && (
                    String(legacySponsor) === String(userId) ||
                    String(legacySponsor) === String(owner.referralCode || '') ||
                    String(legacySponsor) === String(owner.username || '')
                )) {
                    isDirect = true;
                }
            }

            if (!isDirect) continue;
            if (!isUserActive(candidate)) continue;
            if (!hasCampaignActivePackage(candidate)) continue;

            counted.add(candidateUid);
        }

        return Math.max(
            0,
            Math.min(
                Number(counted.size) || 0,
                CAMPAIGN.maxQualifying
            )
        );

    } catch (error) {
        console.error('Campaign direct referral calculation failed:', error);
        return 0;
    }
}

// ============================================================
// FIX 4 — REWARD CALCULATION
// $10 per qualified direct referral
// ============================================================
function calculateReward(directCount) {
    const count = Math.max(0, Number(directCount) || 0);

    if (count <= 0) {
        return 0;
    }

    return Number(
        (count * CAMPAIGN.rewardPerReferral).toFixed(2)
    );
}

// ============================================================
// FIX 2 — CURRENT CYCLE PROGRESS
// ============================================================
function getCurrentCycleProgress(directCount) {
    const count = Math.max(0, Number(directCount) || 0);

    if (count === 0) return 0;

    const remainder = count % CAMPAIGN.cycleSize;

    return remainder === 0
        ? CAMPAIGN.cycleSize
        : remainder;
}

function getTotalCyclesCompleted(directCount) {
    return Math.floor(directCount / CAMPAIGN.cycleSize);
}

// ============================================================
// FIX 6 — CAMPAIGN STATUS TIME LOGIC
// ============================================================
function getCampaignStatus() {
    const now = getCampaignNow().getTime();
    const start = CAMPAIGN.startDate.getTime();
    const end = CAMPAIGN.endDate.getTime();

    if (now < start) {
        return 'UPCOMING';
    }

    if (now <= end) {
        return 'ACTIVE';
    }

    return 'ENDED';
}

function getTimeRemaining() {
    const now = getCampaignNow();
    const status = getCampaignStatus();

    if (status === 'UPCOMING') {
        const diff = CAMPAIGN.startDate - now;
        if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
        return {
            days: Math.floor(diff / (1000 * 60 * 60 * 24)),
            hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
            minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
            seconds: Math.floor((diff % (1000 * 60)) / 1000)
        };
    } else if (status === 'ACTIVE') {
        const diff = CAMPAIGN.endDate - now;
        if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
        return {
            days: Math.floor(diff / (1000 * 60 * 60 * 24)),
            hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
            minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
            seconds: Math.floor((diff % (1000 * 60)) / 1000)
        };
    }
    return { days: 0, hours: 0, minutes: 0, seconds: 0 };
}

function formatTimeRemaining(time) {
    if (time.days === 0 && time.hours === 0 && time.minutes === 0 && time.seconds === 0) {
        return 'Offer has ended';
    }
    return `${time.days}d ${time.hours}h ${time.minutes}m ${time.seconds}s`;
}

// ============================================================
// FIX 7 — GET CAMPAIGN REWARD SNAPSHOT
// ============================================================
async function getCampaignRewardSnapshot(userId) {
    try {
        if (!db || !userId) {
            return null;
        }

        const snap = await get(
            ref(
                db,
                `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`
            )
        );

        if (!snap.exists()) {
            return null;
        }

        const data = snap.val();

        if (data && data.isFinalized === true) {
            isWithdrawalFinalized = true;
        }

        return data;
    } catch (error) {
        console.error(
            'Error getting campaign snapshot:',
            error
        );

        return null;
    }
}

// ============================================================
// FIX 8 — FINALIZE CAMPAIGN REWARD
// ============================================================
async function finalizeCampaignReward(userId) {
    try {
        if (!db || !userId) {
            return null;
        }

        if (getCampaignStatus() !== 'ENDED') {
            console.warn(
                'Campaign cannot be finalized before end time.'
            );
            return null;
        }

        const existing = await getCampaignRewardSnapshot(userId);

        if (existing && existing.isFinalized === true) {
            campaignRewardSnapshot = existing;
            isWithdrawalFinalized = true;
            return existing;
        }

        const finalDirectCount =
            await getCampaignDirectReferrals(userId);

        const safeDirectCount = Math.max(
            0,
            Number(finalDirectCount) || 0
        );

        const finalReward =
            calculateReward(safeDirectCount);

        const snapshotData = {
            campaignId: CAMPAIGN.campaignId,
            userId: userId,
            finalDirectCount: safeDirectCount,
            finalReward: finalReward,
            snapshotAt: Date.now(),
            status: 'available',
            isFinalized: true,
            walletAddress: null,
            withdrawalId: null,
            transactionId: null,
            txHash: null,
            paidAt: null
        };

        const result = await runTransaction(
            ref(
                db,
                `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`
            ),
            currentData => {
                if (
                    currentData &&
                    currentData.isFinalized === true
                ) {
                    return currentData;
                }

                return snapshotData;
            }
        );

        if (
            result.committed &&
            result.snapshot.exists()
        ) {
            campaignRewardSnapshot =
                result.snapshot.val();

            isWithdrawalFinalized = true;

            return campaignRewardSnapshot;
        }

        const latest =
            await getCampaignRewardSnapshot(userId);

        if (latest) {
            campaignRewardSnapshot = latest;
            isWithdrawalFinalized =
                latest.isFinalized === true;

            return latest;
        }

        return null;

    } catch (error) {
        console.error(
            '❌ Error finalizing campaign reward:',
            error
        );

        return null;
    }
}

// ============================================================
// FIX 13 — CHECK WITHDRAWAL STATUS
// ============================================================
async function checkWithdrawalStatus(userId) {
    try {
        if (!db || !userId) {
            return null;
        }

        const snap = await get(
            ref(
                db,
                `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`
            )
        );

        if (!snap.exists()) {
            return null;
        }

        return snap.val();
    } catch (error) {
        console.error(
            'Error checking withdrawal status:',
            error
        );

        return null;
    }
}

// ============================================================
// NEW FIX 1 — SETUP WITHDRAWAL LISTENER
// ============================================================
function setupWithdrawalListener(userId) {
    if (withdrawalListenerUnsubscribe) {
        withdrawalListenerUnsubscribe();
        withdrawalListenerUnsubscribe = null;
    }

    if (!userId) {
        withdrawalData = null;
        return;
    }

    const refPath = ref(
        db,
        `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`
    );

    withdrawalListenerUnsubscribe = onValue(
        refPath,
        (snapshot) => {
            if (snapshot.exists()) {
                withdrawalData = snapshot.val();
            } else {
                withdrawalData = null;
            }

            updateUI();
        },
        (error) => {
            console.error(
                'Withdrawal listener error:',
                error
            );
        }
    );
}

function generateWithdrawalId() {
    return 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function generateTxId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
}

// ============================================================
// FIX 20 — WALLET VALIDATION
// ============================================================
function validateBEP20Wallet(address) {
    if (typeof address !== 'string') {
        return false;
    }

    const value = address.trim();

    return /^0x[a-fA-F0-9]{40}$/.test(value);
}

// ============================================================
// FIX 9 + FIX A — WITHDRAWAL CREATION WITH SAFE ROLLBACK
// ============================================================
async function createAtomicWithdrawal(
    userId,
    userData,
    walletAddress
) {
    if (isProcessingWithdrawal) {
        throw new Error(
            'Withdrawal already in progress'
        );
    }

    isProcessingWithdrawal = true;

    let withdrawalId = null;
    let txId = null;

    try {
        if (getCampaignStatus() !== 'ENDED') {
            throw new Error(
                'Campaign has not ended yet'
            );
        }

        if (!isUserActive(userData)) {
            throw new Error(
                'Your ID is not active'
            );
        }

        if (!validateBEP20Wallet(walletAddress)) {
            throw new Error(
                'Invalid BEP-20 wallet address'
            );
        }

        const campaignRef = ref(
            db,
            `campaign_rewards/${userId}/${CAMPAIGN.campaignId}`
        );

        withdrawalId = generateWithdrawalId();
        txId = generateTxId();

        const timestamp = Date.now();

        const lockResult = await runTransaction(
            campaignRef,
            current => {
                if (!current) {
                    return;
                }

                if (current.isFinalized !== true) {
                    return;
                }

                const reward =
                    Number(current.finalReward || 0);

                if (!Number.isFinite(reward) || reward <= 0) {
                    return;
                }

                if (
                    ['pending', 'approved', 'paid']
                        .includes(current.status)
                ) {
                    return;
                }

                return {
                    ...current,
                    status: 'pending',
                    walletAddress: walletAddress,
                    withdrawalId: withdrawalId,
                    transactionId: txId,
                    requestedAt: timestamp,
                    updatedAt: timestamp
                };
            }
        );

        if (!lockResult.committed) {
            throw new Error(
                'Withdrawal already submitted or reward unavailable'
            );
        }

        const lockedCampaign =
            lockResult.snapshot.val();

        if (
            !lockedCampaign ||
            lockedCampaign.withdrawalId !== withdrawalId
        ) {
            throw new Error(
                'Withdrawal request could not be locked'
            );
        }

        const finalReward =
            Number(lockedCampaign.finalReward || 0);

        if (
            !Number.isFinite(finalReward) ||
            finalReward <= 0
        ) {
            throw new Error(
                'No eligible reward'
            );
        }

        const date =
            new Date(timestamp)
                .toISOString()
                .split('T')[0];

        const adminData = {
            ...lockedCampaign,
            campaignName:
                'RND Direct Referral $50+ Package Offer',
            type:
                'direct_offer_50pack_withdrawal',
            asset: 'USDT',
            network:
                'BEP-20 / BNB Smart Chain',
            amount: finalReward,
            status: 'pending'
        };

        const transactionData = {
            type:
                'direct_offer_50pack_withdrawal',
            subtype:
                'Direct Referral $50+ Package Offer Withdrawal',
            amount: finalReward,
            currency: 'USDT',
            network:
                'BEP-20 / BNB Smart Chain',
            status: 'pending',
            walletAddress: walletAddress,
            withdrawalId: withdrawalId,
            timestamp: timestamp,
            date: date,
            description:
                `Direct Referral $50+ Package Offer Withdrawal of $${finalReward} USDT (BEP-20)`,
            txId: txId,
            txHash: null
        };

        const globalTxData = {
            ...transactionData,
            userId: userId,
            username:
                userData.username ||
                userData.referralCode ||
                userId
        };

        try {
            await update(
                ref(db),
                {
                    [`admin/withdrawals/${withdrawalId}`]:
                        adminData,

                    [`users/${userId}/transactions/${txId}`]:
                        transactionData,

                    [`transactions/${txId}`]:
                        globalTxData
                }
            );
        } catch (writeError) {

            console.error(
                'Withdrawal write error — verifying Firebase state:',
                writeError
            );

            let adminExists = false;
            let userTxExists = false;
            let globalTxExists = false;

            try {
                const [adminSnap, userTxSnap, globalTxSnap] =
                    await Promise.all([
                        get(ref(db, `admin/withdrawals/${withdrawalId}`)),
                        get(ref(db, `users/${userId}/transactions/${txId}`)),
                        get(ref(db, `transactions/${txId}`))
                    ]);

                adminExists = adminSnap.exists();
                userTxExists = userTxSnap.exists();
                globalTxExists = globalTxSnap.exists();
            } catch (verifyError) {
                console.error(
                    'Firebase verification failed — keeping reward in pending state:',
                    verifyError
                );

                throw new Error(
                    'Network error. Your withdrawal request may still be processing. ' +
                    'Please do NOT retry immediately. Check your transaction history in a few minutes.'
                );
            }

            const anyRecordExists =
                adminExists || userTxExists || globalTxExists;

            const allRecordsExist =
                adminExists && userTxExists && globalTxExists;

            if (allRecordsExist) {
                console.warn(
                    'All withdrawal records exist — treating as success despite client error.'
                );

                return {
                    success: true,
                    withdrawalId: withdrawalId,
                    txId: txId
                };
            }

            if (anyRecordExists) {
                console.error(
                    'PARTIAL withdrawal write detected. ' +
                    'Keeping reward in pending state for admin review.',
                    {
                        adminExists,
                        userTxExists,
                        globalTxExists
                    }
                );

                throw new Error(
                    'Your withdrawal request is in an uncertain state. ' +
                    'Please contact support. Do NOT retry.'
                );
            }

            console.warn(
                'No withdrawal records found — safe to rollback reward lock.'
            );

            try {
                await runTransaction(
                    campaignRef,
                    current => {
                        if (!current) {
                            return;
                        }

                        if (
                            current.status === 'pending' &&
                            current.withdrawalId === withdrawalId &&
                            current.transactionId === txId
                        ) {
                            return {
                                ...current,
                                status: 'available',
                                walletAddress: null,
                                withdrawalId: null,
                                transactionId: null,
                                requestedAt: null,
                                updatedAt: Date.now()
                            };
                        }

                        return current;
                    }
                );
            } catch (rollbackError) {
                console.error(
                    'Withdrawal rollback failed:',
                    rollbackError
                );

                throw new Error(
                    'Withdrawal failed and rollback also failed. ' +
                    'Please contact support.'
                );
            }

            throw new Error(
                writeError.message ||
                'Withdrawal submission failed. Please try again.'
            );
        }

        return {
            success: true,
            withdrawalId: withdrawalId,
            txId: txId
        };

    } finally {
        isProcessingWithdrawal = false;
    }
}

// ============================================================
// TOAST UTILITY
// ============================================================
function showToast(message, type = 'success') {
    const container = el.toastContainer;
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const iconMap = {
        success: 'bi-check-circle-fill text-success',
        error: 'bi-exclamation-triangle-fill text-danger',
        warning: 'bi-exclamation-triangle-fill text-warning',
        info: 'bi-info-circle-fill text-info'
    };
    toast.innerHTML = `<i class="bi ${iconMap[type] || iconMap.success}"></i><span class="toast-msg">${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// FIX 21 — RENDER CYCLE PROGRESS CARDS
// ============================================================
function renderCycleProgress(directCount) {
    const grid = el.cycleProgressGrid;

    if (!grid) {
        return;
    }

    grid.innerHTML = '';

    const count =
        Math.max(
            0,
            Number(directCount) || 0
        );

    const totalCycles =
        Math.max(
            1,
            Math.ceil(
                count / CAMPAIGN.cycleSize
            ) + 1
        );

    let foundNext = false;

    for (
        let i = 1;
        i <= totalCycles;
        i++
    ) {
        const cycleEnd =
            i * CAMPAIGN.cycleSize;

        const cycleReward =
            i * CAMPAIGN.cycleReward;

        const achieved =
            count >= cycleEnd;

        const isNext =
            !achieved &&
            !foundNext;

        if (isNext) {
            foundNext = true;
        }

        let statusClass = 'locked';
        let statusText = 'Locked';

        if (achieved) {
            statusClass = 'achieved';
            statusText = '✓ Complete';
        } else if (isNext) {
            statusClass = 'next';
            statusText = 'Current';
        }

        const card =
            document.createElement('div');

        card.className =
            `cycle-card ${statusClass}`;

        card.innerHTML = `
            <div class="cycle-label">
                Cycle ${i}
            </div>

            <div class="cycle-refs">
                ${cycleEnd}
                <small>refs</small>
            </div>

            <div class="cycle-reward">
                $${cycleReward}
            </div>

            <span class="cycle-status ${statusClass}">
                ${statusText}
            </span>
        `;

        grid.appendChild(card);
    }
}

// ============================================================
// FIX 12 + FIX B — UPDATE WITHDRAWAL UI
// ============================================================
function updateWithdrawalUI(reward, status) {
    const campaignStatus = getCampaignStatus();

    const isEligible =
        Number(directReferrals) > 0 &&
        Number(reward) > 0;

    const isWithdrawn =
        !!status &&
        ['pending', 'approved', 'paid']
            .includes(String(status.status || '').toLowerCase());

    let displayReward = reward;
    if (campaignStatus === 'ENDED' && campaignRewardSnapshot) {
        displayReward = Number(campaignRewardSnapshot.finalReward ?? 0);
    }

    if (el.withdrawAmount) {
        el.withdrawAmount.textContent = '$' + displayReward.toFixed(2) + ' USDT';
    }

    const showWalletForm = campaignStatus === 'ENDED' && isEligible && !isWithdrawn;
    if (el.walletFormGroup) {
        el.walletFormGroup.style.display = showWalletForm ? 'block' : 'none';
    }

    if (el.withdrawalInfoBox) {
        el.withdrawalInfoBox.style.display = 'block';
    }

    if (status) {
        const normalizedStatus = String(status.status || '').toLowerCase();

        if (normalizedStatus === 'pending') {
            if (el.withdrawBtn) {
                el.withdrawBtn.disabled = true;
                el.withdrawBtn.innerHTML = '<i class="bi bi-clock me-2"></i>Pending Approval';
                el.withdrawBtn.className = 'btn-withdraw btn-pending';
            }
            if (el.withdrawalInfoText) {
                el.withdrawalInfoText.textContent = '⏳ Your withdrawal request is pending admin approval.';
            }
            if (el.withdrawalStatus) {
                el.withdrawalStatus.className = 'withdrawal-status visible pending';
                el.withdrawalStatus.textContent = 'Your withdrawal request is under admin review.';
            }
            if (el.withdrawalDetails) {
                el.withdrawalDetails.classList.remove('visible');
            }
            if (el.withdrawalSubtitle) {
                el.withdrawalSubtitle.textContent = 'Withdrawal pending approval';
            }
        } else if (normalizedStatus === 'approved') {
            if (el.withdrawBtn) {
                el.withdrawBtn.disabled = true;
                el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Approved';
                el.withdrawBtn.className = 'btn-withdraw btn-approved';
            }
            if (el.withdrawalInfoText) {
                el.withdrawalInfoText.textContent = '✅ Your withdrawal has been approved and is being processed.';
            }
            if (el.withdrawalStatus) {
                el.withdrawalStatus.className = 'withdrawal-status visible approved';
                el.withdrawalStatus.textContent = 'Your withdrawal has been approved and is being processed.';
            }
            if (el.withdrawalDetails) {
                el.withdrawalDetails.classList.remove('visible');
            }
            if (el.withdrawalSubtitle) {
                el.withdrawalSubtitle.textContent = 'Withdrawal approved - processing payment';
            }
        } else if (normalizedStatus === 'paid') {
            if (el.withdrawBtn) {
                el.withdrawBtn.disabled = true;
                el.withdrawBtn.innerHTML = '<i class="bi bi-check-circle-fill me-2"></i>Paid ✓';
                el.withdrawBtn.className = 'btn-withdraw btn-paid';
            }
            if (el.withdrawalInfoText) {
                el.withdrawalInfoText.textContent = '✅ Payment completed successfully!';
            }
            if (el.withdrawalStatus) {
                el.withdrawalStatus.className = 'withdrawal-status visible paid';
                el.withdrawalStatus.textContent = 'Payment has been sent to your wallet.';
            }
            if (el.withdrawalDetails) {
                el.withdrawalDetails.classList.add('visible');
            }
            if (el.detailAmount) {
                el.detailAmount.textContent = '$' + (status.finalReward || displayReward).toFixed(2) + ' USDT';
            }
            if (el.detailWallet) {
                el.detailWallet.textContent = status.walletAddress || '---';
            }
            if (el.detailPaidDate) {
                el.detailPaidDate.textContent = status.paidAt ? new Date(status.paidAt).toLocaleString() : '---';
            }
            if (el.detailTxHash) {
                el.detailTxHash.textContent = status.txHash || 'Pending';
            }
            if (el.withdrawalSubtitle) {
                el.withdrawalSubtitle.textContent = '✅ Payment Completed';
            }
        } else if (normalizedStatus === 'rejected') {
            if (el.withdrawBtn) {
                el.withdrawBtn.disabled = false;
                el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
                el.withdrawBtn.className = 'btn-withdraw btn-rejected';
            }
            if (el.withdrawalInfoText) {
                el.withdrawalInfoText.textContent = '⚠️ Your previous request was rejected. You can try again.';
            }
            if (el.withdrawalStatus) {
                el.withdrawalStatus.className = 'withdrawal-status visible rejected';
                el.withdrawalStatus.textContent = 'Your request was rejected. Please check your wallet address and try again.';
            }
            if (el.withdrawalDetails) {
                el.withdrawalDetails.classList.remove('visible');
            }
            if (el.withdrawalSubtitle) {
                el.withdrawalSubtitle.textContent = 'Request rejected - try again';
            }
        }
        return;
    }

    if (campaignStatus === 'UPCOMING') {
        if (el.withdrawBtn) {
            el.withdrawBtn.disabled = true;
            el.withdrawBtn.innerHTML = '⏳ Withdrawal Opens After Offer Ends';
            el.withdrawBtn.className = 'btn-withdraw withdrawal-locked';
        }
        const time = getTimeRemaining();
        if (el.withdrawalInfoText) {
            el.withdrawalInfoText.textContent = `📅 Campaign starts on 10 October 2026. Withdrawal will be available after the offer ends on 24 October 2026. Time until start: ${formatTimeRemaining(time)}`;
        }
        if (el.withdrawalStatus) {
            el.withdrawalStatus.classList.remove('visible');
        }
        if (el.withdrawalDetails) {
            el.withdrawalDetails.classList.remove('visible');
        }
        if (el.withdrawalSubtitle) {
            el.withdrawalSubtitle.textContent = 'Withdrawal not available yet';
        }
    } else if (campaignStatus === 'ACTIVE') {
        if (el.withdrawBtn) {
            el.withdrawBtn.disabled = true;
            el.withdrawBtn.innerHTML = '🔒 Withdrawal Locked — Offer Active';
            el.withdrawBtn.className = 'btn-withdraw withdrawal-locked';
        }
        const time = getTimeRemaining();
        if (el.withdrawalInfoText) {
            el.withdrawalInfoText.textContent = `🔒 Withdrawal is locked while the offer is active. It will open after 24 October 2026. Time remaining: ${formatTimeRemaining(time)}`;
        }
        if (el.withdrawalStatus) {
            el.withdrawalStatus.classList.remove('visible');
        }
        if (el.withdrawalDetails) {
            el.withdrawalDetails.classList.remove('visible');
        }
        if (el.withdrawalSubtitle) {
            el.withdrawalSubtitle.textContent = 'Withdrawal locked - offer active';
        }
    } else if (campaignStatus === 'ENDED') {
        if (isEligible) {
            if (el.withdrawBtn) {
                el.withdrawBtn.disabled = false;
                el.withdrawBtn.innerHTML = '<i class="bi bi-arrow-up-right me-2"></i>Withdraw Reward';
                el.withdrawBtn.className = 'btn-withdraw';
            }
            if (el.withdrawalInfoText) {
                el.withdrawalInfoText.textContent = '🎉 Offer ended! You are eligible to withdraw your reward.';
            }
            if (el.withdrawalStatus) {
                el.withdrawalStatus.classList.remove('visible');
            }
            if (el.withdrawalDetails) {
                el.withdrawalDetails.classList.remove('visible');
            }
            if (el.withdrawalSubtitle) {
                el.withdrawalSubtitle.textContent = 'Withdrawal available - claim your reward!';
            }
        } else {
            if (el.withdrawBtn) {
                el.withdrawBtn.disabled = true;
                el.withdrawBtn.innerHTML = '⛔ Not Eligible';
                el.withdrawBtn.className = 'btn-withdraw withdrawal-locked';
            }
            if (el.withdrawalInfoText) {
                el.withdrawalInfoText.textContent = 'Complete at least 1 qualified referral to be eligible for withdrawal.';
            }
            if (el.withdrawalStatus) {
                el.withdrawalStatus.classList.remove('visible');
            }
            if (el.withdrawalDetails) {
                el.withdrawalDetails.classList.remove('visible');
            }
            if (el.withdrawalSubtitle) {
                el.withdrawalSubtitle.textContent = 'Not eligible for withdrawal';
            }
        }
    }
}

// ============================================================
// FIX 11 — REFERRAL REFRESH FUNCTION
// ============================================================
async function refreshCampaignDirectCount() {
    if (
        !currentUserId ||
        getCampaignStatus() !== 'ACTIVE' ||
        isWithdrawalFinalized
    ) {
        return;
    }

    try {
        const latest =
            await getCampaignDirectReferrals(
                currentUserId
            );

        const safeLatest =
            Math.max(
                0,
                Number(latest) || 0
            );

        if (safeLatest !== directReferrals) {
            directReferrals = safeLatest;

            if (el.totalReferralsDisplay) {
                el.totalReferralsDisplay.textContent =
                    String(directReferrals);
            }

            updateUI();
        }
    } catch (error) {
        console.error(
            'Campaign referral refresh failed:',
            error
        );
    }
}

// ============================================================
// FIX 10 — REFERRAL REFRESH INTERVAL
// ============================================================
function startReferralRefresh() {
    if (referralRefreshInterval) {
        clearInterval(referralRefreshInterval);
        referralRefreshInterval = null;
    }

    if (
        !currentUserId ||
        getCampaignStatus() !== 'ACTIVE' ||
        isWithdrawalFinalized
    ) {
        return;
    }

    referralRefreshInterval =
        setInterval(() => {
            if (
                !currentUserId ||
                getCampaignStatus() !== 'ACTIVE' ||
                isWithdrawalFinalized
            ) {
                clearInterval(referralRefreshInterval);
                referralRefreshInterval = null;
                return;
            }

            refreshCampaignDirectCount();
        }, 60000);
}

// ============================================================
// FIX 1 + FIX 3 — UPDATE UI
// ============================================================
function updateUI() {
    const campaignStatus = getCampaignStatus();
    const statusBadge = {
        'UPCOMING': { class: 'upcoming', text: '⏳ Upcoming - Starts 10 Oct 2026' },
        'ACTIVE': { class: 'active', text: '🔥 ACTIVE - Refer & Earn $10 per Referral!' },
        'ENDED': { class: 'ended', text: '🏁 Offer Ended - Withdrawal Available' }
    }[campaignStatus] || { class: 'upcoming', text: '⏳ Upcoming' };

    if (el.campaignStatusBadge) {
        el.campaignStatusBadge.innerHTML = `<span class="campaign-status-badge ${statusBadge.class}">${statusBadge.text}</span>`;
    }

    let displayReward = calculateReward(directReferrals);
    let displayDirectCount = directReferrals;
    let isFinal = false;

    if (campaignStatus === 'ENDED' && campaignRewardSnapshot) {
        displayReward = Number(campaignRewardSnapshot.finalReward ?? 0);
        displayDirectCount = Number(campaignRewardSnapshot.finalDirectCount ?? 0);
        isFinal = true;
        isWithdrawalFinalized = true;
    }

    if (el.statDirectRefs) el.statDirectRefs.textContent = displayDirectCount;
    if (el.statEligibleReward) el.statEligibleReward.textContent = '$' + displayReward;
    if (el.statReferralPeriod) {
        el.statReferralPeriod.textContent = campaignStatus === 'ENDED' ? 'Final Count' : 'Campaign Period';
    }

    if (el.statRewardNote) {
        if (displayDirectCount > 0) {
            const cycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize);
            const cycleInfo = cycles > 0 ? `${cycles} cycle${cycles > 1 ? 's' : ''} completed` : '';
            el.statRewardNote.textContent = isFinal
                ? `🏆 Final: $${displayReward} (${displayDirectCount} qualified refs)`
                : `💰 $${displayReward} earned (${displayDirectCount} refs)${cycleInfo ? ' • ' + cycleInfo : ''}`;
            el.statRewardNote.style.color = '#fbbf24';
        } else {
            el.statRewardNote.textContent = 'Earn $10 per qualified $50+ package referral';
            el.statRewardNote.style.color = '#64748b';
        }
    }

    const completedCycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize);
    const nextCycleEnd = (completedCycles + 1) * CAMPAIGN.cycleSize;
    const nextMilestoneReward = (completedCycles + 1) * CAMPAIGN.cycleReward;
    const neededForNextCycle = Math.max(0, nextCycleEnd - displayDirectCount);

    if (el.statNextMilestone) {
        el.statNextMilestone.textContent = `${nextCycleEnd} → $${nextMilestoneReward}`;
    }

    if (el.statNextMilestoneSub) {
        el.statNextMilestoneSub.textContent = `${neededForNextCycle} more needed for next cycle`;
    }

    if (el.statMaxReward) {
        el.statMaxReward.textContent = '∞';
        el.statMaxReward.style.color = '#a78bfa';
    }

    const cycleProgress = getCurrentCycleProgress(displayDirectCount);

    const progressPercent =
        Math.min(
            100,
            Math.max(
                0,
                (cycleProgress / CAMPAIGN.cycleSize) * 100
            )
        );

    if (el.progressCurrent) el.progressCurrent.textContent = String(cycleProgress);
    if (el.progressTarget) el.progressTarget.textContent = String(CAMPAIGN.cycleSize);
    if (el.progressFill) el.progressFill.style.width = progressPercent + '%';

    const neededForCycle =
        Math.max(0, CAMPAIGN.cycleSize - cycleProgress);

    if (cycleProgress === CAMPAIGN.cycleSize) {
        if (el.needMore) el.needMore.textContent = '0';
        if (el.nextMilestoneText) {
            el.nextMilestoneText.innerHTML =
                '<i class="bi bi-trophy" style="color:#fbbf24;"></i> ' +
                '🎉 Cycle complete! Start the next cycle by referring more $50+ package users.';
        }
    } else {
        if (el.needMore) el.needMore.textContent = String(neededForCycle);
        if (el.nextMilestoneText) {
            el.nextMilestoneText.innerHTML =
                '<i class="bi bi-bullseye" style="color:#fbbf24;"></i> ' +
                `Need <strong>${neededForCycle}</strong> more qualified referrals ` +
                'to complete this $50 cycle.';
        }
    }

    renderCycleProgress(displayDirectCount);

    if (el.notEligibleBox) {
        if (displayDirectCount === 0) {
            el.notEligibleBox.classList.add('visible');
        } else {
            el.notEligibleBox.classList.remove('visible');
        }
    }

    if (el.walletAmount) {
        el.walletAmount.textContent = displayReward.toFixed(2);
    }

    if (isFinal) {
        if (el.finalBadge) el.finalBadge.style.display = 'inline';
        if (el.walletLabel) el.walletLabel.textContent = 'Final Offer Earnings';
        if (el.walletStatusText) {
            if (displayReward > 0) {
                el.walletStatusText.textContent = `🏆 Final earnings locked! $${displayReward} USDT from ${displayDirectCount} qualified referrals.`;
            } else {
                el.walletStatusText.textContent = 'No reward earned this campaign.';
            }
        }
    } else {
        if (el.finalBadge) el.finalBadge.style.display = 'none';
        if (el.walletLabel) el.walletLabel.textContent = 'Estimated Offer Earnings';
        if (el.walletStatusText) {
            if (displayReward === 0) {
                el.walletStatusText.textContent = '💡 Refer users who activate the $50+ package to earn $10 each!';
            } else {
                const cycles = Math.floor(displayDirectCount / CAMPAIGN.cycleSize);
                const remainder = displayDirectCount % CAMPAIGN.cycleSize;
                if (remainder === 0 && cycles > 0) {
                    el.walletStatusText.textContent = `💰 $${displayReward} USDT earned! ${cycles} full cycle${cycles > 1 ? 's' : ''} completed.`;
                } else {
                    el.walletStatusText.textContent = `💰 $${displayReward} USDT estimated! ${CAMPAIGN.cycleSize - remainder} more to complete this cycle.`;
                }
            }
        }
    }

    updateWithdrawalUI(displayReward, withdrawalData);
}

// ============================================================
// SHOW DAYS REMAINING POPUP
// ============================================================
function showDaysPopup() {
    const campaignStatus = getCampaignStatus();
    const reward = calculateReward(directReferrals);
    const time = getTimeRemaining();

    if (campaignStatus === 'UPCOMING') {
        if (el.popupIcon) el.popupIcon.textContent = '📅';
        if (el.popupTitle) el.popupTitle.textContent = 'Offer Not Started Yet';
        if (el.popupText) el.popupText.innerHTML = `
            The $50+ Package Direct Referral Offer has not started yet.
            <br><br>
            <strong>Starts:</strong> 10 October 2026
            <br>
            <strong>Ends:</strong> 24 October 2026
            <br>
            <strong>Your Estimated Reward:</strong> $${reward.toFixed(2)} USDT
            <br><br>
            <span style="color:#94a3b8;font-size:0.9rem;">Time until offer starts:</span>
            <div class="popup-days">${time.days > 0 ? time.days + 'd' : ''} ${time.hours}h ${time.minutes}m</div>
        `;
    } else if (campaignStatus === 'ACTIVE') {
        if (el.popupIcon) el.popupIcon.textContent = '🔒';
        if (el.popupTitle) el.popupTitle.textContent = 'Withdrawal Locked — Offer Active';
        if (el.popupText) el.popupText.innerHTML = `
            🔒 Your reward is currently locked while the offer is active.
            <br><br>
            <strong>Your Estimated Reward:</strong> $${reward.toFixed(2)} USDT
            <br>
            <strong>Offer Ends:</strong> 24 October 2026 at 23:59:59 IST
            <br>
            <strong>Withdrawal Opens:</strong> After the campaign end time
            <br><br>
            <span style="color:#94a3b8;font-size:0.9rem;">Time Remaining:</span>
            <div class="popup-days">${formatTimeRemaining(time)}</div>
        `;
    } else if (campaignStatus === 'ENDED') {
        const finalReward = campaignRewardSnapshot ? Number(campaignRewardSnapshot.finalReward ?? 0) : reward;
        if (finalReward > 0) {
            if (el.popupIcon) el.popupIcon.textContent = '🎉';
            if (el.popupTitle) el.popupTitle.textContent = 'Offer Ended!';
            if (el.popupText) el.popupText.innerHTML = `
                Your withdrawal is now available.
                <br><br>
                <strong>Eligible Reward:</strong> $${finalReward.toFixed(2)} USDT
                <br><br>
                Click <strong>"Withdraw Reward"</strong> to continue.
            `;
        } else {
            if (el.popupIcon) el.popupIcon.textContent = '⛔';
            if (el.popupTitle) el.popupTitle.textContent = 'Not Eligible';
            if (el.popupText) el.popupText.innerHTML = `
                You are not eligible for withdrawal because you have 0 qualified referrals.
                <br><br>
                <strong>Minimum required:</strong> 1 Qualified Direct Referral ($50+ package)
                <br>
                <strong>Your qualified referrals:</strong> ${directReferrals}
            `;
        }
    }

    if (el.daysPopup) {
        el.daysPopup.classList.add('visible');
    }
}

// ============================================================
// FIX 14 — HANDLE WITHDRAWAL BUTTON CLICK
// ============================================================
function handleWithdrawClick() {
    const status = getCampaignStatus();

    if (status !== 'ENDED') {
        showDaysPopup();
        return;
    }

    let reward = 0;

    if (
        campaignRewardSnapshot &&
        campaignRewardSnapshot.isFinalized === true
    ) {
        reward =
            Number(
                campaignRewardSnapshot.finalReward || 0
            );
    } else {
        reward =
            calculateReward(directReferrals);
    }

    if (!Number.isFinite(reward) || reward <= 0) {
        showDaysPopup();
        return;
    }

    if (
        withdrawalData &&
        ['pending', 'approved', 'paid']
            .includes(
                String(
                    withdrawalData.status || ''
                ).toLowerCase()
            )
    ) {
        showToast(
            'You have already submitted a withdrawal request.',
            'warning'
        );
        return;
    }

    const walletAddress =
        el.walletAddressInput ? el.walletAddressInput.value.trim() : '';

    if (!validateBEP20Wallet(walletAddress)) {
        showToast(
            'Please enter a valid BEP-20 USDT wallet address (0x...).',
            'error'
        );

        if (el.walletAddressInput) {
            el.walletAddressInput.classList.add('error');
        }

        return;
    }

    showConfirmationModal(
        reward,
        walletAddress
    );
}

// ============================================================
// FIX 16 — SHOW CONFIRMATION MODAL
// ============================================================
function showConfirmationModal(
    reward,
    walletAddress
) {
    const safeReward =
        Number(reward);

    if (el.confirmAmount) {
        el.confirmAmount.textContent =
            '$' +
            (
                Number.isFinite(safeReward)
                    ? safeReward.toFixed(2)
                    : '0.00'
            ) +
            ' USDT';
    }

    if (el.confirmWallet) {
        el.confirmWallet.textContent =
            String(walletAddress || '');
    }

    if (el.confirmationModal) {
        el.confirmationModal.classList.add(
            'visible'
        );
    }
}

// ============================================================
// FIX 15 + FIX C — PROCESS WITHDRAWAL
// ============================================================
async function processWithdrawal() {

    if (isProcessingWithdrawal) {
        return;
    }

    const originalSubmitHTML =
        '<i class="bi bi-check-circle me-1"></i>Confirm Withdrawal';

    if (el.confirmSubmit) {
        el.confirmSubmit.disabled = true;
        el.confirmSubmit.innerHTML =
            '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';
    }

    try {
        const walletAddress =
            el.walletAddressInput ? el.walletAddressInput.value.trim() : '';

        if (!validateBEP20Wallet(walletAddress)) {
            showToast('Please enter a valid BEP-20 USDT wallet address.', 'error');
            return;
        }

        if (getCampaignStatus() !== 'ENDED') {
            showToast('Withdrawal is only available after the offer ends.', 'error');
            return;
        }

        const userSnap = await get(ref(db, 'users/' + currentUserId));

        if (!userSnap.exists()) {
            showToast('User data not found.', 'error');
            return;
        }

        const latestUserData = userSnap.val();

        if (!isUserActive(latestUserData)) {
            showToast('You are not eligible because your ID is not active.', 'error');
            return;
        }

        let snapshot = await getCampaignRewardSnapshot(currentUserId);

        if (!snapshot) {
            snapshot = await finalizeCampaignReward(currentUserId);
        }

        if (
            !snapshot ||
            !snapshot.isFinalized ||
            Number(snapshot.finalReward || 0) <= 0
        ) {
            showToast('No finalized eligible reward is available.', 'error');
            return;
        }

        const reward = Number(snapshot.finalReward ?? 0);

        if (reward <= 0) {
            showToast('You are not eligible for this reward.', 'error');
            return;
        }

        if (
            withdrawalData &&
            ['pending', 'approved', 'paid']
                .includes(
                    String(withdrawalData.status || '').toLowerCase()
                )
        ) {
            showToast('You have already submitted a withdrawal request.', 'warning');
            return;
        }

        const result = await createAtomicWithdrawal(
            currentUserId,
            latestUserData,
            walletAddress
        );

        if (result.success) {
            showToast(
                '✅ Your withdrawal request has been submitted successfully.',
                'success'
            );

            withdrawalData =
                await checkWithdrawalStatus(currentUserId);

            if (el.walletAddressInput) {
                el.walletAddressInput.value = '';
            }
            if (el.confirmationModal) {
                el.confirmationModal.classList.remove('visible');
            }

            updateUI();
        } else {
            showToast('❌ Failed to submit withdrawal request.', 'error');
        }

    } catch (error) {
        console.error('Withdrawal error:', error);

        showToast(
            '❌ ' +
            (error.message ||
                'Error submitting withdrawal request. Please try again.'),
            'error'
        );

    } finally {
        isProcessingWithdrawal = false;
        if (el.confirmSubmit) {
            el.confirmSubmit.disabled = false;
            el.confirmSubmit.innerHTML = originalSubmitHTML;
        }
    }
}

// ============================================================
// LOAD USER DATA — SAFETY WRAPPED
// ============================================================
async function loadUserData(user) {
    try {
        // ============================================================
        // SAFETY: invalid user object
        // ============================================================
        if (!user || !user.uid) {
            console.error('loadUserData: invalid user object');
            showToast('User session error. Please login again.', 'error');
            if (el.loadingOverlay) {
                el.loadingOverlay.classList.add('hidden');
            }
            return;
        }

        currentUserId = user.uid;
        const userSnap = await get(ref(db, 'users/' + user.uid));
        if (!userSnap.exists()) {
            showToast('User data not found. Please complete registration.', 'error');
            return;
        }

        currentUserData = userSnap.val();
        const name = currentUserData.name || currentUserData.username || 'User';
        if (el.userName) el.userName.textContent = name;
        if (el.userAvatar) el.userAvatar.textContent = name.charAt(0).toUpperCase();

        campaignRewardSnapshot =
            await getCampaignRewardSnapshot(user.uid);

        isWithdrawalFinalized =
            campaignRewardSnapshot?.isFinalized === true;

        const userIsActive = isUserActive(currentUserData);

        if (!userIsActive) {
            directReferrals = 0;
            console.log('ℹ️ User inactive - offer count forced to 0');
        } else {
            directReferrals = await getCampaignDirectReferrals(user.uid);
        }

        if (getCampaignStatus() === 'ENDED' && !campaignRewardSnapshot) {
            campaignRewardSnapshot = await finalizeCampaignReward(user.uid);
            if (campaignRewardSnapshot) {
                isWithdrawalFinalized =
                    campaignRewardSnapshot.isFinalized === true;
                directReferrals = Number(campaignRewardSnapshot.finalDirectCount ?? 0);
            }
        }

        setupWithdrawalListener(user.uid);
        withdrawalData = await checkWithdrawalStatus(user.uid);

        const referralCode = currentUserData.referralCode || user.uid.substring(0, 8).toUpperCase();
        const link = `https://staking.randigital.in/register.html?ref=${referralCode}`;
        if (el.referralLinkDisplay) el.referralLinkDisplay.textContent = link;
        if (el.referralCodeDisplay) el.referralCodeDisplay.textContent = referralCode;
        if (el.totalReferralsDisplay) el.totalReferralsDisplay.textContent = directReferrals;

        startCountdown();
        updateUI();

        const status = getCampaignStatus();
        if (status === 'UPCOMING') {
            showToast('📢 $50+ Package Direct Referral Offer starts on 10 October 2026!', 'warning');
        } else if (status === 'ACTIVE') {
            if (userIsActive) {
                showToast('🎯 Offer is ACTIVE! Refer $50+ package users and earn $10 each!', 'success');
                startReferralRefresh();
            } else {
                showToast('ℹ️ Activate your ID with a $50+ package to participate in this offer.', 'info');
            }
        } else if (status === 'ENDED') {
            if (directReferrals > 0) {
                showToast('🏆 Offer ended! You are eligible for reward withdrawal.', 'success');
            } else {
                showToast('⏰ Offer ended. You need at least 1 qualified referral ($50+ package) to qualify.', 'warning');
            }
        }

    } catch (error) {
        console.error('Error loading user data:', error);
        showToast(
            'Error loading data: ' +
            (error?.message || 'Unknown error'),
            'error'
        );
    } finally {
        // ============================================================
        // SAFETY: हर हाल में loading overlay बंद करें
        // ============================================================
        if (el.loadingOverlay) {
            el.loadingOverlay.classList.add('hidden');
        }
    }
}

// ============================================================
// FIX 17 — COUNTDOWN
// ============================================================
function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);

    function update() {
        const time = getTimeRemaining();
        const status = getCampaignStatus();

        if (status === 'ENDED') {
            if (el.countdownWrapper) el.countdownWrapper.style.display = 'none';
            if (el.campaignEndedMessage) el.campaignEndedMessage.style.display = 'block';

            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }

            if (referralRefreshInterval) {
                clearInterval(referralRefreshInterval);
                referralRefreshInterval = null;
            }

            if (
                !isWithdrawalFinalized &&
                currentUserId
            ) {
                finalizeCampaignReward(
                    currentUserId
                ).then(snapshot => {

                    if (snapshot) {
                        campaignRewardSnapshot =
                            snapshot;

                        directReferrals =
                            Number(
                                snapshot.finalDirectCount || 0
                            );

                        isWithdrawalFinalized =
                            snapshot.isFinalized === true;
                    }

                    updateUI();
                });
            }

            updateUI();
            return;
        }

        if (el.countdownDays) el.countdownDays.textContent = String(time.days).padStart(2, '0');
        if (el.countdownHours) el.countdownHours.textContent = String(time.hours).padStart(2, '0');
        if (el.countdownMinutes) el.countdownMinutes.textContent = String(time.minutes).padStart(2, '0');
        if (el.countdownSeconds) el.countdownSeconds.textContent = String(time.seconds).padStart(2, '0');
    }

    update();
    countdownInterval = setInterval(update, 1000);
}

// ============================================================
// WALLET ADDRESS VALIDATION UI
// ============================================================
function setupWalletValidation() {
    if (!el.walletAddressInput) return;

    el.walletAddressInput.addEventListener('input', () => {
        const value = el.walletAddressInput.value.trim();
        const msg = el.walletValidationMsg;

        if (!msg) return;

        if (!value) {
            el.walletAddressInput.className = 'form-control-custom';
            msg.className = 'wallet-validation-msg';
            msg.textContent = '';
            return;
        }

        if (validateBEP20Wallet(value)) {
            el.walletAddressInput.className = 'form-control-custom valid';
            msg.className = 'wallet-validation-msg valid';
            msg.textContent = '✅ Valid BEP-20 wallet address';
        } else {
            el.walletAddressInput.className = 'form-control-custom error';
            msg.className = 'wallet-validation-msg error';
            msg.textContent = '❌ Invalid BEP-20 wallet address. Must start with 0x and contain 40 hex characters.';
        }
    });
}

// ============================================================
// COPY REFERRAL LINK
// ============================================================
async function copyReferralLink() {
    const link = el.referralLinkDisplay ? el.referralLinkDisplay.textContent : '';
    if (!link || link === 'Loading...') {
        showToast('Please wait, referral link is loading...', 'warning');
        return;
    }
    try {
        await navigator.clipboard.writeText(link);
        if (el.copyReferralBtn) {
            el.copyReferralBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
            el.copyReferralBtn.classList.add('copied');
        }
        showToast('✅ Referral link copied!', 'success');
        setTimeout(() => {
            if (el.copyReferralBtn) {
                el.copyReferralBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy Referral Link';
                el.copyReferralBtn.classList.remove('copied');
            }
        }, 3000);
    } catch {
        const textArea = document.createElement('textarea');
        textArea.value = link;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        if (el.copyReferralBtn) {
            el.copyReferralBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
        }
        showToast('✅ Referral link copied!', 'success');
        setTimeout(() => {
            if (el.copyReferralBtn) {
                el.copyReferralBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy Referral Link';
            }
        }, 3000);
    }
}

// ============================================================
// LOGOUT
// ============================================================
async function handleLogout() {
    try {
        await signOut(auth);
        window.location.href = 'login.html';
    } catch (error) {
        showToast('Error logging out.', 'error');
    }
}

// ============================================================
// FIX 19 — SETUP LISTENERS
// ============================================================
function setupListeners() {
    if (listenersInitialized) {
        return;
    }

    listenersInitialized = true;

    if (el.copyReferralBtn) el.copyReferralBtn.addEventListener('click', copyReferralLink);
    if (el.logoutBtn) el.logoutBtn.addEventListener('click', handleLogout);
    if (el.withdrawBtn) el.withdrawBtn.addEventListener('click', handleWithdrawClick);

    if (el.popupCloseBtn) {
        el.popupCloseBtn.addEventListener('click', () => {
            el.daysPopup.classList.remove('visible');
        });
    }
    if (el.daysPopup) {
        el.daysPopup.addEventListener('click', (e) => {
            if (e.target === el.daysPopup) {
                el.daysPopup.classList.remove('visible');
            }
        });
    }
    if (el.confirmCancel) {
        el.confirmCancel.addEventListener('click', () => {
            el.confirmationModal.classList.remove('visible');
        });
    }
    if (el.confirmationModal) {
        el.confirmationModal.addEventListener('click', (e) => {
            if (e.target === el.confirmationModal) {
                el.confirmationModal.classList.remove('visible');
            }
        });
    }
    if (el.confirmSubmit) {
        el.confirmSubmit.addEventListener('click', processWithdrawal);
    }

    setupWalletValidation();
}

// ============================================================
// FIX 18 — GLOBAL VISIBILITY CHANGE LISTENER
// ============================================================
document.addEventListener(
    'visibilitychange',
    () => {
        if (
            document.visibilityState === 'visible' &&
            currentUserId &&
            getCampaignStatus() === 'ACTIVE' &&
            !isWithdrawalFinalized
        ) {
            refreshCampaignDirectCount();
        }
    }
);

// ============================================================
// FIX 3 (new) — CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    if (referralRefreshInterval) {
        clearInterval(referralRefreshInterval);
        referralRefreshInterval = null;
    }

    if (withdrawalListenerUnsubscribe) {
        try {
            withdrawalListenerUnsubscribe();
        } catch (e) {
            console.warn('Error during withdrawal listener cleanup:', e);
        }
        withdrawalListenerUnsubscribe = null;
    }

    if (serverTimeListenerUnsubscribe) {
        try {
            serverTimeListenerUnsubscribe();
        } catch (e) {
            console.warn('Error during server time listener cleanup:', e);
        }
        serverTimeListenerUnsubscribe = null;
    }
});

// ============================================================
// MAIN AUTH HANDLER — NON-BLOCKING
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    // Server time sync NON-BLOCKING है — page load को नहीं रोकेगा।
    // यह background में चलता रहेगा और offset मिलते ही countdown update होगा।
    syncFirebaseServerTime();

    // User data load करें
    await loadUserData(user);

    // Listeners attach करें
    setupListeners();
});

console.log('✅ $50+ Package Direct Offer — FINAL PRODUCTION VERSION');
console.log('📅 Campaign:', CAMPAIGN.campaignId);
console.log('💰 $10 per qualified referral ($50+ package qualifies)');
console.log('🔄 Every 5 referrals = $50 cycle (unlimited)');
console.log('🔒 Withdrawal: Locked until Offer ENDED');
console.log('⏱️ Server time sync: onValue() non-blocking');
console.log('🔥 Firebase: rnd2-70080');
