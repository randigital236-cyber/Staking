// ============================================================
// 🔥 WITHDRAWAL PAGE LOGIC - RND STAKING (v9.0 - Low-bandwidth + Hardened)
// ============================================================
// v9.0 changes (vs v8.3) — behaviour for the user stays the same:
//   [COST] Never downloads the whole users/{uid} node any more
//          (it contained ALL transactions). Only small fields are read.
//   [COST] Balance deduction is a transaction on ONLY the wallet balance
//          field (was: whole user node download + upload, with retries).
//   [COST] Withdrawal history = max 20 latest withdrawal txs (query), not all txs.
//   [COST] Reconcile reads only 1 tiny node (activeWithdrawal) instead of
//          every request + full user node inside a loop.
//   [COST] withdrawalSettings is read once and cached (was 3-4 reads / action).
//   [COST] No page reload after a successful withdrawal (UI updated locally).
//   [SAFE] Multi-tab/double-click lock is now ATOMIC (transaction).
//   [SAFE] tx record + admin withdrawal + request status + lock release are
//          written in ONE atomic multi-path update (all-or-nothing).
//   [SAFE] Offline check: no debit attempt when the device is offline.
//   [SAFE] Auto-recovery if network drops after balance deduction.
//   [FIX]  isSubmitting was released 500ms after password modal closed, even
//          while the withdrawal was running (double-submit hole). Fixed.
//   [FIX]  First-time "set password" could overwrite an existing password
//          (stale cache / second tab). Now re-checked fresh before saving.
//   [FIX]  Amount validation hardened (regex, max 8 decimals, no "1e5").
//   [FIX]  XSS-safe rendering (escapeHtml) + toast uses textContent.
//   [FIX]  showToast duration argument was ignored. Fixed.
//   [FIX]  Brute-force counter is now atomic (transaction).
// ============================================================

import { initializeApp } from "firebase/app";
import {
    getAuth,
    onAuthStateChanged,
    signOut,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "firebase/auth";
import {
    getDatabase, ref, get, set, update, push, runTransaction, remove,
    query, orderByChild, equalTo, limitToLast
} from "firebase/database";

// ============================================================
// 🔥 FIREBASE CONFIG
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
// 🔥 CONSTANTS
// ============================================================
const WITHDRAW_CONFIG = {
    referralWallet: { min: 20, currency: 'USDT', label: 'Referral Wallet', display: 'Referral Wallet (USDT - BEP20)', decimals: 2 },
    rndWallet:      { min: 5,  currency: 'RND',  label: 'RND Wallet',      display: 'RND Wallet (RND - BEP20)',      decimals: 4 }
};

const BEP20_REGEX = /^0x[a-fA-F0-9]{40}$/;
const AMOUNT_REGEX = /^\d+(\.\d{1,8})?$/;
const PASSWORD_MIN_LEN = 6;

const LOCK_TTL = 30 * 60 * 1000;            // withdrawal lock auto-expiry
const RECONCILE_MIN_AGE = 2 * 60 * 1000;    // don't touch very fresh requests
const PASSWORD_LOCK_MS = 10 * 60 * 1000;    // brute-force lock
const HISTORY_LIMIT = 20;                   // latest withdrawals shown
const OP_TIMEOUT = 20000;                   // ms

const USER_FIELDS = [
    'username', 'referralCode', 'name', 'totalReferrals',
    'depositWallet', 'referralWallet', 'rndWallet', 'lockedRND'
];

// ============================================================
// 🔥 STATE (in-memory only — avoids repeat downloads)
// ============================================================
const state = {
    user: null,
    userData: null,
    withdrawals: [],
    settings: null,
    selectedWallet: 'referralWallet',
    initUid: null
};

let isSubmitting = false;
let addressChangeMode = false;
let savedAddress = '';

// ============================================================
// 🔐 HASH (djb2-based, salted with uid) — unchanged, existing passwords keep working
// ============================================================
function hashWithdrawalPassword(uid, password) {
    const input = `rnd_${uid}_${password}_stake_v6`;
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash) + input.charCodeAt(i);
        hash = hash & 0xffffffff;
    }
    let h2 = 52711;
    for (let i = input.length - 1; i >= 0; i--) {
        h2 = ((h2 << 5) + h2) ^ input.charCodeAt(i);
        h2 = h2 & 0xffffffff;
    }
    const part1 = (hash >>> 0).toString(16).padStart(8, '0');
    const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
    return `wd_${part1}${part2}`;
}

// ============================================================
// 🔥 UTILITY
// ============================================================
function roundTo8(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100000000) / 100000000;
}

function randomId(len = 8) {
    return Math.random().toString(36).slice(2, 2 + len);
}

function generateRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'wd_req_' + Date.now() + '_' + randomId(9);
}

function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(promise, ms = OP_TIMEOUT) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const e = new Error('Request timed out');
            e.code = 'TIMEOUT';
            reject(e);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function formatPlain(n) {
    // number -> plain decimal string, max 8 decimals, no trailing zeros, no exponent
    return roundTo8(n).toFixed(8).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function showToast(message, type = 'success', duration) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;

    const icons = {
        success: 'bi-check-circle-fill',
        error: 'bi-x-octagon-fill',
        info: 'bi-info-circle-fill',
        warning: 'bi-exclamation-triangle-fill'
    };
    const colors = {
        success: '#2ecc71',
        error: '#f87171',
        info: '#60a5fa',
        warning: '#fbbf24'
    };

    const icon = document.createElement('i');
    icon.className = `bi ${icons[type] || icons.info}`;
    icon.style.color = colors[type] || colors.info;

    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(msg);
    container.appendChild(toast);

    const ms = duration || (type === 'error' ? 8000 : type === 'warning' ? 7000 : 5000);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, ms);
}

function setBusy(busy) {
    const btn = document.getElementById('withdrawBtn');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.innerHTML = busy
        ? '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Processing...'
        : '<i class="bi bi-arrow-up-circle"></i> <span>Submit Withdrawal</span>';
}

function releaseSubmit() {
    isSubmitting = false;
    setBusy(false);
}

// ============================================================
// 👁️ PASSWORD EYE TOGGLE
// ============================================================
function attachPasswordEyeToggles() {
    const pairs = [
        ['withdrawPasswordInput', 'toggleWdPwd1'],
        ['withdrawPasswordConfirm', 'toggleWdPwd2'],
        ['fpAccountPassword', 'toggleFpAcc'],
        ['fpNewPassword', 'toggleFpNew'],
        ['fpConfirmPassword', 'toggleFpConfirm']
    ];

    pairs.forEach(([inputId, btnId]) => {
        const input = document.getElementById(inputId);
        const btn = document.getElementById(btnId);
        if (!input || !btn) return;
        if (btn.dataset.eyeBound === '1') return;
        btn.dataset.eyeBound = '1';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            const icon = btn.querySelector('i');
            if (icon) icon.className = isPassword ? 'bi bi-eye-slash' : 'bi bi-eye';
            btn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
            input.focus();
        });
    });
}

// ============================================================
// 🔥 SIDEBAR
// ============================================================
const sidebarPanel = document.getElementById('sidebarPanel');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarClose = document.getElementById('sidebarClose');

function openSidebar() {
    if (!sidebarPanel || !sidebarOverlay) return;
    sidebarPanel.classList.add('open');
    sidebarOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeSidebar() {
    if (!sidebarPanel || !sidebarOverlay) return;
    sidebarPanel.classList.remove('open');
    sidebarOverlay.classList.remove('active');
    document.body.style.overflow = '';
}

if (sidebarToggle) sidebarToggle.addEventListener('click', openSidebar);
if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

const logoutBtn = document.getElementById('logoutBtnSidebar');
if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await signOut(auth); } catch (err) { console.error('Logout error:', err); }
        window.location.href = 'login.html';
    });
}

// ============================================================
// 🔥 DATA READS (small, targeted)
// ============================================================
async function getUserSummary(uid) {
    const snaps = await Promise.all(
        USER_FIELDS.map((f) => get(ref(db, `users/${uid}/${f}`)))
    );
    const data = {};
    let any = false;
    USER_FIELDS.forEach((f, i) => {
        if (snaps[i].exists()) { data[f] = snaps[i].val(); any = true; }
    });
    return any ? data : null;
}

async function getBalance(uid, walletType) {
    const snap = await get(ref(db, `users/${uid}/${walletType}`));
    return roundTo8(snap.exists() ? snap.val() : 0);
}

// Latest withdrawals only. For best savings add  ".indexOn": ["type"]
// under users/$uid/transactions in Firebase rules (see notes).
async function getWithdrawalHistory(uid) {
    const q = query(
        ref(db, `users/${uid}/transactions`),
        orderByChild('type'),
        equalTo('withdrawal'),
        limitToLast(HISTORY_LIMIT)
    );
    const snap = await get(q);
    const list = [];
    snap.forEach((child) => {
        const tx = child.val();
        if (tx && tx.type === 'withdrawal') list.push({ id: child.key, ...tx });
    });
    list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return list;
}

// ============================================================
// 🔐 WITHDRAWAL SETTINGS (cached in memory)
// ============================================================
const EMPTY_SETTINGS = () => ({ savedAddress: '', addressUpdatedAt: 0, passwordHash: '', passwordUpdatedAt: 0 });

// Throws on network/permission error on purpose (never pretend "no password").
async function getWithdrawalSettings(uid, force = false) {
    if (state.settings && !force) return state.settings;
    const snap = await get(ref(db, `users/${uid}/withdrawalSettings`));
    state.settings = snap.exists() ? (snap.val() || EMPTY_SETTINGS()) : EMPTY_SETTINGS();
    return state.settings;
}

async function saveWithdrawalAddress(uid, address) {
    const cleanAddress = String(address || '').trim();
    if (!BEP20_REGEX.test(cleanAddress)) throw new Error('Invalid BEP20 wallet address.');
    const now = Date.now();
    await withTimeout(set(ref(db, `users/${uid}/withdrawalSettings/savedAddress`), cleanAddress));
    await withTimeout(set(ref(db, `users/${uid}/withdrawalSettings/addressUpdatedAt`), now));
    if (!state.settings) state.settings = EMPTY_SETTINGS();
    state.settings.savedAddress = cleanAddress;
    state.settings.addressUpdatedAt = now;
    return true;
}

async function saveWithdrawalPasswordHash(uid, passwordHash) {
    const now = Date.now();
    await withTimeout(set(ref(db, `users/${uid}/withdrawalSettings/passwordHash`), passwordHash));
    await withTimeout(set(ref(db, `users/${uid}/withdrawalSettings/passwordUpdatedAt`), now));
    if (!state.settings) state.settings = EMPTY_SETTINGS();
    state.settings.passwordHash = passwordHash;
    state.settings.passwordUpdatedAt = now;
    return true;
}

async function clearPasswordAttempts(uid) {
    try {
        await remove(ref(db, `users/${uid}/withdrawalSettings/passwordAttempts`));
        if (state.settings) delete state.settings.passwordAttempts;
    } catch (e) { /* non-critical */ }
}

// ============================================================
// 🔐 VERIFY WITHDRAWAL PASSWORD (brute-force protected)
// ============================================================
async function registerFailedAttempt(uid) {
    const attemptsRef = ref(db, `users/${uid}/withdrawalSettings/passwordAttempts`);
    let locked = false;
    await runTransaction(attemptsRef, (cur) => {
        const c = cur || { count: 0, lockUntil: 0 };
        const next = (Number(c.count) || 0) + 1;
        if (next >= 5) {
            locked = true;
            return { count: 0, lockUntil: Date.now() + PASSWORD_LOCK_MS };
        }
        locked = false;
        return { count: next, lockUntil: 0 };
    });
    return locked;
}

async function verifyWithdrawalPasswordFromDB(uid, password) {
    if (!password || String(password).length < PASSWORD_MIN_LEN) {
        return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LEN} characters.` };
    }

    // One fresh read gives: hash + attempts
    const settings = await getWithdrawalSettings(uid, true);
    const attempts = settings.passwordAttempts || { count: 0, lockUntil: 0 };

    if (Date.now() < (attempts.lockUntil || 0)) {
        const mins = Math.max(1, Math.ceil((attempts.lockUntil - Date.now()) / 60000));
        return { ok: false, error: `Too many incorrect attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.` };
    }

    const storedHash = String(settings.passwordHash || '').trim();
    if (!storedHash) return { ok: false, error: 'NO_PASSWORD_SET' };

    const inputHash = hashWithdrawalPassword(uid, String(password));
    if (inputHash !== storedHash) {
        let locked = false;
        try { locked = await registerFailedAttempt(uid); } catch (e) { console.warn('Attempt counter error:', e); }
        return {
            ok: false,
            error: locked
                ? 'Too many incorrect attempts. Try again in 10 minutes.'
                : 'Incorrect withdrawal password.'
        };
    }

    if (settings.passwordAttempts) await clearPasswordAttempts(uid);
    return { ok: true };
}

// ============================================================
// 🔐 ACCOUNT PASSWORD RE-AUTHENTICATION
// ============================================================
async function verifyAccountPassword(user, password) {
    if (!user) throw new Error('Session expired. Please login again.');
    if (!user.email) throw new Error('Your account does not have an email address for verification.');
    if (!password) throw new Error('Please enter your account password.');

    const credential = EmailAuthProvider.credential(user.email, password);
    try {
        await reauthenticateWithCredential(user, credential);
        return true;
    } catch (err) {
        console.error('Account re-auth failed:', err);
        if (
            err.code === 'auth/wrong-password' ||
            err.code === 'auth/invalid-credential' ||
            err.code === 'auth/invalid-login-credentials'
        ) throw new Error('Incorrect account password.');
        if (err.code === 'auth/too-many-requests') throw new Error('Too many failed attempts. Please try again later.');
        throw new Error('Account verification failed. Please try again.');
    }
}

// ============================================================
// 🔥 WITHDRAWAL ENGINE
// ============================================================
const slotPath = (uid, requestId) => `users/${uid}/withdrawalRequests/${requestId}`;
const lockPath = (uid) => `users/${uid}/activeWithdrawal`;

// Atomic lock: only ONE withdrawal at a time per user (multi-tab / double click safe)
async function acquireWithdrawalLock(uid, requestId) {
    const res = await withTimeout(runTransaction(ref(db, lockPath(uid)), (cur) => {
        if (cur && cur.createdAt && Date.now() - cur.createdAt < LOCK_TTL) return; // abort: already locked
        return { requestId, createdAt: Date.now() };
    }));
    return res.committed;
}

async function releaseLock(uid) {
    try { await withTimeout(remove(ref(db, lockPath(uid))), 10000); }
    catch (e) { console.warn('Unable to remove withdrawal lock (auto-expires in 30 min)', e); }
}

// Deduct ONLY the wallet field (tiny download/upload).
// Returns: ok | insufficient | unknown (timeout, may still apply) | error (not applied)
async function deductBalance(uid, walletType, amount) {
    const balRef = ref(db, `users/${uid}/${walletType}`);
    const amt = roundTo8(amount);
    let ok = false;
    try {
        const res = await withTimeout(runTransaction(balRef, (cur) => {
            ok = false;
            if (cur === null) return 0;                // local cache empty: server re-runs with real value
            const bal = roundTo8(cur);
            if (!(amt > 0) || !(bal >= amt)) return;   // abort
            ok = true;
            return roundTo8(bal - amt);
        }));
        if (res.committed && ok) {
            return { status: 'ok', newBalance: roundTo8(res.snapshot.val()) };
        }
        return { status: 'insufficient' };
    } catch (err) {
        if (err && err.code === 'TIMEOUT') return { status: 'unknown' };
        console.error('Deduct error:', err);
        return { status: 'error', error: err };
    }
}

function buildFinalizeUpdates(uid, p) {
    const ts = Number(p.createdAt) || Date.now();
    const amt = roundTo8(p.amount);
    const addr = String(p.address || '');
    const updates = {};

    // 1) user's transaction record (same shape as before)
    updates[`users/${uid}/transactions/${p.withdrawalId}`] = {
        type: 'withdrawal',
        withdrawalId: p.withdrawalId,
        requestId: p.requestId,
        amount: amt,
        currency: p.currency,
        walletType: p.walletType,
        walletAddress: addr,
        timestamp: ts,
        date: new Date(ts).toDateString(),
        status: 'pending',
        description: `Withdrawal of ${amt} ${p.currency} to ${addr.substring(0, 15)}...`
    };

    // 2) admin panel record (same shape as before)
    updates[`withdrawals/${p.adminKey}`] = {
        uid,
        withdrawalId: p.withdrawalId,
        requestId: p.requestId,
        amount: amt,
        currency: p.currency,
        walletType: p.walletType,
        wallet: addr,
        status: 'pending',
        timestamp: ts
    };

    // 3) request slot -> terminal success state
    const sp = slotPath(uid, p.requestId);
    updates[`${sp}/status`] = 'admin_received';
    updates[`${sp}/withdrawalId`] = p.withdrawalId;
    updates[`${sp}/adminReceivedAt`] = Date.now();
    updates[`${sp}/adminWithdrawalKey`] = p.adminKey;
    updates[`${sp}/completedAt`] = Date.now();

    // 4) release lock — atomically with everything above
    updates[lockPath(uid)] = null;
    return updates;
}

// Idempotent (fixed paths) -> safe to retry / replay
async function finalizeWithdrawal(uid, payload) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await withTimeout(update(ref(db), buildFinalizeUpdates(uid, payload)), 15000);
            return true;
        } catch (err) {
            lastErr = err;
            console.warn(`Finalize attempt ${attempt} failed:`, err);
            if (attempt < 3) await sleep(800 * attempt);
        }
    }
    throw lastErr || new Error('Finalize failed');
}

async function markSlotFailed(uid, requestId, reason) {
    const sp = slotPath(uid, requestId);
    try {
        await withTimeout(update(ref(db), {
            [`${sp}/status`]: 'failed',
            [`${sp}/reason`]: reason,
            [`${sp}/failedAt`]: Date.now(),
            [lockPath(uid)]: null
        }), 15000);
    } catch (e) {
        console.warn('Could not mark slot failed (lock auto-expires):', e);
    }
}

// ============================================================
// 🔥 RECONCILE (1 tiny read on a normal page load)
// ============================================================
async function reconcileActiveWithdrawal(uid) {
    const lockRef = ref(db, lockPath(uid));
    const lockSnap = await get(lockRef);
    if (!lockSnap.exists()) return;                        // normal case: nothing to do

    const lock = lockSnap.val();
    const requestId = lock && typeof lock === 'object' ? lock.requestId : null;
    const lockAge = Date.now() - Number((lock && lock.createdAt) || 0);

    if (!requestId) {
        if (lockAge >= RECONCILE_MIN_AGE) await remove(lockRef);
        return;
    }

    const slotSnap = await get(ref(db, slotPath(uid, requestId)));
    if (!slotSnap.exists()) {
        if (lockAge >= RECONCILE_MIN_AGE) await remove(lockRef);
        return;
    }

    const slot = slotSnap.val() || {};

    if (slot.status === 'admin_received' || slot.status === 'failed' || slot.status === 'completed') {
        await remove(lockRef);                              // stale lock of a finished request
        return;
    }
    if (slot.status !== 'processing') return;               // needs_review etc. — leave for expiry

    const age = Date.now() - Number(slot.createdAt || 0);
    if (age < RECONCILE_MIN_AGE) return;                    // maybe still running in another tab

    // Legacy slot (older version) — just let the lock expire
    if (!slot.withdrawalId || !slot.adminKey) {
        if (age >= LOCK_TTL) await remove(lockRef);
        return;
    }

    let deducted = slot.deducted === true;
    if (!deducted) {
        // Decide from the balance whether the debit really happened
        const cur = await getBalance(uid, slot.walletType);
        const before = roundTo8(slot.balanceBefore);
        const after = roundTo8(before - roundTo8(slot.amount));

        if (cur === before) {
            await markSlotFailed(uid, requestId, 'Not deducted (recovered)');
            return;
        }
        if (cur === after) {
            deducted = true;
        } else {
            await update(ref(db), { [`${slotPath(uid, requestId)}/status`]: 'needs_review' });
            return;
        }
    }

    if (deducted) {
        // Balance was deducted but records were not completed -> complete them now
        await finalizeWithdrawal(uid, { ...slot, requestId });
        console.log('✅ Recovered interrupted withdrawal:', requestId);
    }
}

// ============================================================
// 🔥 RUN ONE WITHDRAWAL (called only after password verified)
// ============================================================
async function runWithdrawal(user, { walletType, amount, address, cfg, saveAddr }) {
    const uid = user.uid;
    const requestId = generateRequestId();
    const withdrawalId = 'wd_' + Date.now() + '_' + randomId(8);
    const adminKey = push(ref(db, 'withdrawals')).key;   // local id, no network
    const createdAt = Date.now();
    let lockAcquired = false;

    // ---- Stage 1: lock + slot (nothing debited yet) ----
    let balanceBefore = 0;
    try {
        lockAcquired = await acquireWithdrawalLock(uid, requestId);
        if (!lockAcquired) {
            showToast('Withdrawal already processing. Please wait.', 'warning');
            return;
        }

        balanceBefore = await withTimeout(getBalance(uid, walletType));
        if (balanceBefore < amount) {
            await releaseLock(uid);
            showToast(`❌ Insufficient balance! You have only ${balanceBefore.toFixed(4)} ${cfg.currency}.`, 'error');
            return;
        }

        await withTimeout(set(ref(db, slotPath(uid, requestId)), {
            requestId,
            uid,
            walletType,
            amount: roundTo8(amount),
            currency: cfg.currency,
            address,
            withdrawalId,
            adminKey,
            balanceBefore,
            deducted: false,
            status: 'processing',
            createdAt
        }));
    } catch (err) {
        console.error('Withdrawal prepare error:', err);
        if (lockAcquired) await releaseLock(uid);
        showToast('❌ Network issue. Nothing was deducted. Please try again.', 'error');
        return;
    }

    // ---- Stage 2: debit (only the balance field) ----
    const payload = {
        requestId, withdrawalId, adminKey, walletType,
        amount: roundTo8(amount), currency: cfg.currency, address, createdAt
    };

    const deduct = await deductBalance(uid, walletType, amount);

    if (deduct.status === 'insufficient' || deduct.status === 'error') {
        await markSlotFailed(uid, requestId, deduct.status === 'insufficient' ? 'Insufficient balance' : 'Debit failed');
        showToast(
            deduct.status === 'insufficient'
                ? '❌ Insufficient balance. Please refresh and try again.'
                : '❌ Withdrawal could not be processed. Nothing was deducted.',
            'error'
        );
        return;
    }

    if (deduct.status === 'unknown') {
        // Debit may or may not have reached the server. Keep lock. Auto-recovered on next load.
        showToast('⚠️ Network issue — your request may be processing. DO NOT submit again. Refresh the page after a few minutes to check.', 'warning', 10000);
        return;
    }

    // ---- Stage 3: records (atomic). Balance is already deducted here. ----
    state.userData[walletType] = deduct.newBalance;

    try {
        await finalizeWithdrawal(uid, payload);
    } catch (err) {
        console.error('Finalize failed after debit:', err);
        try { await set(ref(db, `${slotPath(uid, requestId)}/deducted`), true); } catch (e) { /* recovery also works via balance check */ }
        showToast('⚠️ Network issue while saving your request. It will be completed automatically when you reopen this page. DO NOT submit again.', 'warning', 12000);
        refreshUI();
        return;
    }

    // ---- Success ----
    if (addressChangeMode || saveAddr) {
        try { await saveWithdrawalAddress(uid, address); }
        catch (e) { console.warn('Address save failed (non-critical):', e); }
    }

    state.withdrawals.unshift({
        id: withdrawalId,
        type: 'withdrawal',
        withdrawalId,
        requestId,
        amount: roundTo8(amount),
        currency: cfg.currency,
        walletType,
        walletAddress: address,
        timestamp: createdAt,
        status: 'pending'
    });
    state.withdrawals = state.withdrawals.slice(0, HISTORY_LIMIT);

    addressChangeMode = false;
    savedAddress = address;

    showToast(`✅ Withdrawal request submitted! ${amount} ${cfg.currency} will be processed by admin.`, 'success', 6000);
    refreshUI();
}

// ============================================================
// 🔥 RENDER WITHDRAWAL UI
// ============================================================
function renderWithdrawalUI() {
    const container = document.getElementById('withdrawalContent');
    if (!container) return;

    const userData = state.userData || {};
    const withdrawals = state.withdrawals || [];

    const depositWallet = Number(userData.depositWallet) || 0;
    const referralWallet = Number(userData.referralWallet) || 0;
    const rndWallet = Number(userData.rndWallet) || 0;
    const lockedRND = Number(userData.lockedRND) || 0;

    const sel = state.selectedWallet === 'rndWallet' ? 'rndWallet' : 'referralWallet';
    const selCfg = WITHDRAW_CONFIG[sel];
    const selBalance = sel === 'rndWallet' ? rndWallet : referralWallet;

    let historyHtml = '';
    if (withdrawals.length === 0) {
        historyHtml = `
            <div class="empty-state">
                <i class="bi bi-inbox"></i>
                <p>No withdrawal requests yet.</p>
            </div>
        `;
    } else {
        historyHtml = `<div class="withdrawal-history">` + withdrawals.map((w) => {
            let statusHtml = '';
            if (w.status === 'approved')      statusHtml = '<span class="status-approved"><i class="bi bi-check-circle-fill"></i>Approved</span>';
            else if (w.status === 'rejected') statusHtml = '<span class="status-rejected"><i class="bi bi-x-circle-fill"></i>Rejected</span>';
            else                              statusHtml = '<span class="status-pending"><i class="bi bi-clock"></i>Pending</span>';

            const currency = escapeHtml(w.currency || 'RND');
            const walletLabel = w.walletType === 'referralWallet' ? '💳 Referral Wallet' : '📊 RND Wallet';
            const dateStr = w.timestamp ? new Date(w.timestamp).toLocaleString('en-IN') : 'N/A';
            const addr = w.walletAddress ? escapeHtml(String(w.walletAddress).substring(0, 24)) : '';

            return `
                <div class="transaction-item">
                    <div>
                        <div class="amount">${(Number(w.amount) || 0).toFixed(4)} ${currency}</div>
                        <div style="font-size:0.72rem;color:var(--text-secondary);margin-top:2px;">${walletLabel}</div>
                        <div class="date">${escapeHtml(dateStr)}</div>
                        ${addr ? `<div style="font-size:0.62rem;color:var(--text-muted);font-family:'Courier New',monospace;margin-top:2px;">${addr}...</div>` : ''}
                    </div>
                    <div>${statusHtml}</div>
                </div>
            `;
        }).join('') + `</div>`
        + (withdrawals.length >= HISTORY_LIMIT ? `<div class="history-note">Showing your latest ${HISTORY_LIMIT} withdrawals.</div>` : '');
    }

    container.innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="page-header-section">
                    <h4><i class="bi bi-arrow-up-circle"></i> Withdraw Funds</h4>
                    <span class="badge-mini-pill pill-green"><i class="bi bi-shield-check"></i> Secure Withdrawal</span>
                </div>
            </div>

            <div class="col-12">
                <div class="row g-3">
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new deposit">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Deposit Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-wallet2"></i></div>
                            </div>
                            <div class="wallet-card-value">$${depositWallet.toFixed(2)}<span class="wallet-card-currency">USDT</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Not for Withdrawal</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new referral">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Referral Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-people-fill"></i></div>
                            </div>
                            <div class="wallet-card-value">${referralWallet.toFixed(2)}<span class="wallet-card-currency">USDT</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-check-circle-fill"></i>
                                <span class="badge-mini-pill pill-green">✅ Min: 20 USDT</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new rnd">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">RND Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-database"></i></div>
                            </div>
                            <div class="wallet-card-value">${rndWallet.toFixed(4)}<span class="wallet-card-currency">RND</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-check-circle-fill"></i>
                                <span class="badge-mini-pill pill-green">✅ Min: 5 RND</span>
                            </div>
                        </div>
                    </div>

                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new locked">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Locked RND</span>
                                <div class="wallet-card-icon"><i class="bi bi-lock"></i></div>
                            </div>
                            <div class="wallet-card-value">${lockedRND.toFixed(2)}<span class="wallet-card-currency">RND</span></div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Locked</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="col-lg-7 mx-auto">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-arrow-up-circle"></i> Request Withdrawal</div>

                    <div class="info-alert">
                        <i class="bi bi-info-circle"></i>
                        <strong>Withdrawal Limits:</strong>
                        <br>💳 <strong>Referral Wallet:</strong> Min <strong>20 USDT</strong> (BEP20)
                        <br>📊 <strong>RND Wallet:</strong> Min <strong>5 RND</strong> (BEP20)
                        <br>🔒 Deposit & Locked wallets cannot be withdrawn.
                    </div>

                    <div class="row g-2 mb-3" role="radiogroup" aria-label="Select wallet">
                        <div class="col-6">
                            <div class="withdraw-option-card ${sel === 'referralWallet' ? 'selected' : ''}" id="optionReferral" data-wallet="referralWallet"
                                 role="radio" tabindex="0" aria-checked="${sel === 'referralWallet'}">
                                <div class="option-icon">💳</div>
                                <div class="option-label">Referral Wallet</div>
                                <div class="option-balance">${referralWallet.toFixed(2)} USDT</div>
                                <div class="min-label referral-min">Min: 20 USDT (BEP20)</div>
                            </div>
                        </div>
                        <div class="col-6">
                            <div class="withdraw-option-card ${sel === 'rndWallet' ? 'selected' : ''}" id="optionRND" data-wallet="rndWallet"
                                 role="radio" tabindex="0" aria-checked="${sel === 'rndWallet'}">
                                <div class="option-icon">📊</div>
                                <div class="option-label">RND Wallet</div>
                                <div class="option-balance">${rndWallet.toFixed(4)} RND</div>
                                <div class="min-label rnd-min">Min: 5 RND (BEP20)</div>
                            </div>
                        </div>
                    </div>

                    <form id="withdrawForm" autocomplete="off" novalidate>
                        <div class="mb-3">
                            <label class="form-label" for="selectedWalletDisplay">Selected Wallet <span class="required">*</span></label>
                            <input type="text" id="selectedWalletDisplay" class="form-control form-control-custom" value="${selCfg.display}" readonly>
                            <input type="hidden" id="selectedWallet" value="${sel}">
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="withAmount">Amount <span class="required">*</span></label>
                            <div class="amount-wrap">
                                <input type="number" id="withAmount" class="form-control form-control-custom"
                                       placeholder="Enter amount" min="0.00000001" step="any" inputmode="decimal" required>
                                <button type="button" class="max-btn" id="maxAmountBtn">MAX</button>
                            </div>
                            <div class="available-line">
                                <span>Available</span>
                                <strong id="availableBalance">${selBalance.toFixed(selCfg.decimals)} ${selCfg.currency}</strong>
                            </div>
                            <small class="form-hint" id="minAmountHint" style="color:${sel === 'rndWallet' ? '#60a5fa' : '#fbbf24'};">Minimum: ${selCfg.min} ${selCfg.currency} (BEP20) for ${selCfg.label}</small>
                        </div>

                        <div class="mb-3">
                            <label class="form-label">Wallet Address (BEP20) <span class="required">*</span></label>

                            <div id="savedAddressBox"></div>

                            <div id="addressInputBox" style="display:none;">
                                <input type="text" id="withAddr" class="form-control form-control-custom"
                                       placeholder="0x..." autocomplete="off" spellcheck="false" maxlength="42">
                                <small class="form-hint">Enter your BEP20 wallet address (must start with 0x)</small>

                                <div id="saveAddressOption" style="display:none; margin-top:10px; padding:10px 12px;
                                     border-radius:10px; background:rgba(96,165,250,.06);
                                     border:1px solid rgba(96,165,250,.18);">
                                    <label style="display:flex; align-items:flex-start; gap:9px;
                                                  cursor:pointer; font-size:.82rem; margin:0;">
                                        <input type="checkbox" id="saveWithdrawalAddress" style="margin-top:3px;">
                                        <span>
                                            <strong style="color:var(--text-primary);">Save this wallet address</strong><br>
                                            <small style="color:var(--text-secondary);">
                                                You won't need to enter it again next time.
                                            </small>
                                        </span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <button type="submit" class="btn-primary-custom" id="withdrawBtn">
                            <i class="bi bi-arrow-up-circle"></i>
                            <span>Submit Withdrawal</span>
                        </button>
                    </form>

                    <div class="mt-3">
                        <a href="dashboard.html" class="btn-outline-custom">
                            <i class="bi bi-arrow-left"></i> Back to Dashboard
                        </a>
                    </div>
                </div>
            </div>

            <div class="col-lg-7 mx-auto">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-clock-history"></i> Withdrawal History</div>
                    ${historyHtml}
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// 🔥 WALLET OPTION SWITCHER + MAX BUTTON
// ============================================================
function attachOptionHandlers() {
    const optionReferral = document.getElementById('optionReferral');
    const optionRND = document.getElementById('optionRND');

    function selectOption(walletType) {
        const cfg = WITHDRAW_CONFIG[walletType];
        if (!cfg) return;
        state.selectedWallet = walletType;

        [optionReferral, optionRND].forEach((el) => {
            if (!el) return;
            const isSel = el.dataset.wallet === walletType;
            el.classList.toggle('selected', isSel);
            el.setAttribute('aria-checked', String(isSel));
        });

        document.getElementById('selectedWalletDisplay').value = cfg.display;
        document.getElementById('selectedWallet').value = walletType;

        const hint = document.getElementById('minAmountHint');
        hint.textContent = `Minimum: ${cfg.min} ${cfg.currency} (BEP20) for ${cfg.label}`;
        hint.style.color = walletType === 'rndWallet' ? '#60a5fa' : '#fbbf24';

        const bal = Number(state.userData?.[walletType]) || 0;
        const avail = document.getElementById('availableBalance');
        if (avail) avail.textContent = `${bal.toFixed(cfg.decimals)} ${cfg.currency}`;
    }

    [optionReferral, optionRND].forEach((el) => {
        if (!el) return;
        el.addEventListener('click', () => selectOption(el.dataset.wallet));
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectOption(el.dataset.wallet);
            }
        });
    });

    const maxBtn = document.getElementById('maxAmountBtn');
    if (maxBtn) {
        maxBtn.addEventListener('click', () => {
            const walletType = document.getElementById('selectedWallet').value;
            const bal = roundTo8(state.userData?.[walletType] || 0);
            const input = document.getElementById('withAmount');
            if (input && bal > 0) input.value = formatPlain(bal);
            if (input) input.focus();
        });
    }
}

// ============================================================
// 🔐 WITHDRAWAL PASSWORD MODAL (set / verify)
// ============================================================
function openWithdrawPasswordModal(uid, { mode, onSuccess, onCancel }) {
    const modalEl = document.getElementById('withdrawPasswordModal');
    if (!modalEl) {
        showToast('Password UI unavailable.', 'error');
        if (typeof onCancel === 'function') onCancel();
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const titleEl = document.getElementById('wdPwdModalTitle');
    const infoEl = document.getElementById('wdPwdInfo');
    const inputEl = document.getElementById('withdrawPasswordInput');
    const confirmWrap = document.getElementById('wdPwdConfirmWrap');
    const confirmEl = document.getElementById('withdrawPasswordConfirm');
    const errEl = document.getElementById('withdrawPasswordError');
    const confirmBtn = document.getElementById('confirmWithdrawPasswordBtn');
    const btnText = document.getElementById('wdPwdBtnText');
    const forgotBtn = document.getElementById('forgotWithdrawPasswordBtn');

    inputEl.value = '';
    confirmEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';

    // Reset eye toggles to "hidden" state
    [inputEl, confirmEl].forEach((el) => { if (el) el.type = 'password'; });
    document.querySelectorAll('#withdrawPasswordModal .pwd-eye-btn i').forEach((ic) => {
        ic.className = 'bi bi-eye';
    });

    // handedOff = true when the flow continues (verified / forgot / re-open as "set")
    let handedOff = false;
    const onHidden = () => {
        modalEl.removeEventListener('hidden.bs.modal', onHidden);
        if (!handedOff && typeof onCancel === 'function') onCancel();
    };
    modalEl.addEventListener('hidden.bs.modal', onHidden);

    if (mode === 'set') {
        titleEl.innerHTML = `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Set Withdrawal Password`;
        infoEl.innerHTML = `Set a <strong style="color:#2ecc71;">strong withdrawal password</strong> (min 6 characters). You will need it for every withdrawal and to change your saved address.`;
        btnText.textContent = 'Set Password';
        forgotBtn.style.display = 'none';
        confirmWrap.style.display = 'block';
    } else {
        titleEl.innerHTML = `<i class="bi bi-shield-lock-fill" style="color:var(--primary);"></i> Withdrawal Password`;
        infoEl.innerHTML = `Enter your <strong style="color:#2ecc71;">withdrawal password</strong> to continue.`;
        btnText.textContent = 'Verify';
        forgotBtn.style.display = 'inline-block';
        confirmWrap.style.display = 'none';
    }

    const submitOnEnter = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
    };
    inputEl.onkeydown = submitOnEnter;
    confirmEl.onkeydown = submitOnEnter;

    confirmBtn.onclick = async () => {
        const pwd = String(inputEl.value || '');
        const confirmPwd = String(confirmEl.value || '');

        if (!pwd || pwd.length < PASSWORD_MIN_LEN) {
            errEl.textContent = `Password must be at least ${PASSWORD_MIN_LEN} characters.`;
            errEl.style.display = 'block';
            return;
        }

        if (mode === 'set' && pwd !== confirmPwd) {
            errEl.textContent = 'Password and confirm password do not match.';
            errEl.style.display = 'block';
            return;
        }

        confirmBtn.disabled = true;
        const origHTML = confirmBtn.innerHTML;
        confirmBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Please wait...`;
        errEl.style.display = 'none';

        try {
            if (mode === 'set') {
                // Fresh check: never overwrite an existing password from here
                const fresh = await getWithdrawalSettings(uid, true);
                if (fresh.passwordHash && String(fresh.passwordHash).trim()) {
                    errEl.textContent = 'A withdrawal password is already set. Close this window and click "Submit Withdrawal" again to verify it.';
                    errEl.style.display = 'block';
                    return;
                }
                await saveWithdrawalPasswordHash(uid, hashWithdrawalPassword(uid, pwd));
                showToast('✅ Withdrawal password set successfully. Now click "Submit Withdrawal" again to proceed.', 'success', 7000);
                modal.hide();   // not handed off -> onCancel releases the submit button
                return;
            }

            const check = await verifyWithdrawalPasswordFromDB(uid, pwd);
            if (!check.ok) {
                if (check.error === 'NO_PASSWORD_SET') {
                    errEl.textContent = 'No withdrawal password set yet. Please set one now.';
                    errEl.style.display = 'block';
                    handedOff = true;
                    setTimeout(() => {
                        modal.hide();
                        setTimeout(() => openWithdrawPasswordModal(uid, { mode: 'set', onSuccess, onCancel }), 350);
                    }, 900);
                    return;
                }
                errEl.textContent = check.error || 'Incorrect password.';
                errEl.style.display = 'block';
                return;
            }

            handedOff = true;
            modal.hide();
            await onSuccess();

        } catch (err) {
            console.error('Withdrawal password error:', err);
            errEl.textContent = err.message || 'Something went wrong. Please try again.';
            errEl.style.display = 'block';
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = origHTML;
        }
    };

    forgotBtn.onclick = () => {
        handedOff = true;
        modal.hide();
        setTimeout(() => openForgotPasswordModal(uid, { onSuccess, onCancel }), 350);
    };

    modal.show();
    setTimeout(() => inputEl.focus(), 300);
}

// ============================================================
// 🔐 FORGOT PASSWORD MODAL
// ============================================================
// Step 1: Verify ACCOUNT password (Firebase Auth re-auth)
// Step 2: Set new withdrawal password + confirm
function openForgotPasswordModal(uid, { onSuccess, onCancel }) {
    const modalEl = document.getElementById('forgotPasswordModal');
    if (!modalEl) {
        showToast('Forgot-password UI unavailable.', 'error');
        if (typeof onCancel === 'function') onCancel();
        return;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const accEl = document.getElementById('fpAccountPassword');
    const newEl = document.getElementById('fpNewPassword');
    const confEl = document.getElementById('fpConfirmPassword');
    const errEl = document.getElementById('fpError');
    const btn = document.getElementById('confirmForgotPasswordBtn');

    accEl.value = '';
    newEl.value = '';
    confEl.value = '';
    errEl.style.display = 'none';
    errEl.textContent = '';

    [accEl, newEl, confEl].forEach((el) => { if (el) el.type = 'password'; });
    document.querySelectorAll('#forgotPasswordModal .pwd-eye-btn i').forEach((ic) => {
        ic.className = 'bi bi-eye';
    });

    let handedOff = false;
    const onHidden = () => {
        modalEl.removeEventListener('hidden.bs.modal', onHidden);
        if (!handedOff && typeof onCancel === 'function') onCancel();
    };
    modalEl.addEventListener('hidden.bs.modal', onHidden);

    const submitOnEnter = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
    };
    accEl.onkeydown = submitOnEnter;
    newEl.onkeydown = submitOnEnter;
    confEl.onkeydown = submitOnEnter;

    btn.onclick = async () => {
        const accountPwd = String(accEl.value || '');
        const newPwd = String(newEl.value || '');
        const confPwd = String(confEl.value || '');

        if (!accountPwd) {
            errEl.textContent = 'Please enter your account password.';
            errEl.style.display = 'block';
            return;
        }
        if (!newPwd || newPwd.length < PASSWORD_MIN_LEN) {
            errEl.textContent = `New withdrawal password must be at least ${PASSWORD_MIN_LEN} characters.`;
            errEl.style.display = 'block';
            return;
        }
        if (newPwd !== confPwd) {
            errEl.textContent = 'New password and confirm password do not match.';
            errEl.style.display = 'block';
            return;
        }
        if (newPwd === accountPwd) {
            errEl.textContent = 'Withdrawal password should be different from your account password.';
            errEl.style.display = 'block';
            return;
        }

        btn.disabled = true;
        const origHTML = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Please wait...`;
        errEl.style.display = 'none';

        try {
            await verifyAccountPassword(auth.currentUser, accountPwd);

            await saveWithdrawalPasswordHash(uid, hashWithdrawalPassword(uid, newPwd));
            await clearPasswordAttempts(uid);

            showToast('✅ Withdrawal password reset successfully.', 'success');
            handedOff = true;
            modal.hide();

            if (typeof onSuccess === 'function') {
                setTimeout(() => onSuccess(), 400);
            }
        } catch (err) {
            console.error('Forgot password error:', err);
            errEl.textContent = err.message || 'Something went wrong. Please try again.';
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHTML;
        }
    };

    modal.show();
    setTimeout(() => accEl.focus(), 300);
}

// ============================================================
// 💳 SAVED ADDRESS UI (uses cached settings — no download)
// ============================================================
function initializeWithdrawalAddressUI() {
    const uid = state.user && state.user.uid;
    const savedAddressBox = document.getElementById('savedAddressBox');
    const addressInputBox = document.getElementById('addressInputBox');
    if (!uid || !savedAddressBox || !addressInputBox) return;

    savedAddress = String((state.settings && state.settings.savedAddress) || '').trim();
    addressChangeMode = false;

    const existingRow = document.getElementById('changeAddressActionRow');
    if (existingRow) existingRow.remove();

    if (!savedAddress) {
        savedAddressBox.style.display = 'block';
        savedAddressBox.innerHTML = `
            <div style="border:1px dashed rgba(96,165,250,.35);
                        background:rgba(96,165,250,.04);
                        border-radius:12px; padding:14px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <i class="bi bi-wallet2" style="font-size:1.2rem;color:#60a5fa;"></i>
                    <strong style="color:#fff; font-size:.88rem;">Add your BEP20 wallet address</strong>
                </div>
                <div style="font-size:.78rem; color:var(--text-secondary); margin-bottom:12px;">
                    You can save this address for future withdrawals.
                </div>
                <button type="button" class="btn-outline-custom" id="enterAddressBtn"
                        style="width:auto; padding:10px 18px; font-size:.82rem;">
                    <i class="bi bi-plus-circle"></i> Add Wallet Address
                </button>
            </div>
        `;

        addressInputBox.style.display = 'none';

        document.getElementById('enterAddressBtn')?.addEventListener('click', () => {
            addressInputBox.style.display = 'block';
            savedAddressBox.style.display = 'none';
            const saveOpt = document.getElementById('saveAddressOption');
            if (saveOpt) saveOpt.style.display = 'block';
            document.getElementById('withAddr')?.focus();
        });
        return;
    }

    const shortAddress = `${savedAddress.substring(0, 10)}...${savedAddress.slice(-8)}`;

    savedAddressBox.style.display = 'block';
    savedAddressBox.innerHTML = `
        <div style="border:1px solid rgba(46,204,113,.30);
                    background:rgba(46,204,113,.06);
                    border-radius:12px; padding:14px;">
            <div style="display:flex; justify-content:space-between;
                        align-items:center; gap:10px; flex-wrap:wrap;">
                <div style="min-width:0; flex:1;">
                    <div style="color:#2ecc71; font-size:.78rem;
                                font-weight:700; margin-bottom:5px;">
                        <i class="bi bi-shield-check"></i> SAVED BEP20 ADDRESS
                    </div>
                    <div style="font-family:'Courier New',monospace;
                                font-size:.82rem; color:#e2e8f0;
                                word-break:break-all;" title="${escapeHtml(savedAddress)}">
                        ${escapeHtml(shortAddress)}
                    </div>
                </div>
                <button type="button" class="btn-outline-custom"
                        id="changeAddressBtn"
                        style="width:auto; padding:8px 14px; font-size:.78rem; white-space:nowrap;">
                    <i class="bi bi-pencil"></i> Change
                </button>
            </div>
        </div>
    `;

    addressInputBox.style.display = 'none';

    // CHANGE ADDRESS -> withdrawal password must be verified first
    document.getElementById('changeAddressBtn')?.addEventListener('click', async () => {
        let settings;
        try {
            settings = await getWithdrawalSettings(uid);
        } catch (e) {
            showToast('❌ Network issue. Please try again.', 'error');
            return;
        }
        const hasPassword = !!(settings.passwordHash && String(settings.passwordHash).trim());

        if (!hasPassword) {
            showToast('Please set a withdrawal password first.', 'warning');
            openWithdrawPasswordModal(uid, { mode: 'set' });
            return;
        }

        openWithdrawPasswordModal(uid, {
            mode: 'verify',
            onSuccess: () => { showChangeAddressUI(savedAddress); }
        });
    });
}

// ============================================================
// 🔄 CHANGE SAVED ADDRESS UI (only after password verified)
// ============================================================
function showChangeAddressUI(oldAddress) {
    const savedAddressBox = document.getElementById('savedAddressBox');
    const addressInputBox = document.getElementById('addressInputBox');
    const addressInput = document.getElementById('withAddr');
    const saveOpt = document.getElementById('saveAddressOption');

    if (!savedAddressBox || !addressInputBox || !addressInput) return;

    savedAddressBox.style.display = 'block';
    savedAddressBox.innerHTML = `
        <div style="border:1px solid rgba(251,191,36,.30);
                    background:rgba(251,191,36,.06);
                    border-radius:12px; padding:14px;">
            <div style="color:#fbbf24; font-weight:700; font-size:.85rem; margin-bottom:6px;">
                <i class="bi bi-exclamation-triangle"></i> Change Wallet Address
            </div>
            <div style="font-size:.78rem; color:var(--text-secondary);">
                Enter your new BEP20 address below and click <strong>Save Address</strong>.
            </div>
        </div>
    `;

    addressInputBox.style.display = 'block';
    addressInput.value = '';
    addressInput.focus();

    if (saveOpt) saveOpt.style.display = 'none';

    let actionRow = document.getElementById('changeAddressActionRow');
    if (!actionRow) {
        actionRow = document.createElement('div');
        actionRow.id = 'changeAddressActionRow';
        actionRow.style.display = 'flex';
        actionRow.style.gap = '8px';
        actionRow.style.marginTop = '10px';
        actionRow.innerHTML = `
            <button type="button" class="btn-primary-custom" id="saveNewAddressBtn"
                    style="flex:1; padding:10px 16px; font-size:.85rem;">
                <i class="bi bi-check-circle"></i> Save Address
            </button>
            <button type="button" class="btn-outline-custom" id="cancelChangeAddressBtn"
                    style="flex:1; padding:10px 16px; font-size:.85rem;">
                <i class="bi bi-x-circle"></i> Cancel
            </button>
        `;
        addressInputBox.appendChild(actionRow);
    } else {
        actionRow.style.display = 'flex';
    }

    document.getElementById('cancelChangeAddressBtn').onclick = () => {
        addressInput.value = '';
        addressChangeMode = false;
        initializeWithdrawalAddressUI();
    };

    document.getElementById('saveNewAddressBtn').onclick = async () => {
        const newAddr = String(addressInput.value || '').trim();

        if (!BEP20_REGEX.test(newAddr)) {
            showToast('❌ Please enter a valid BEP20 wallet address (0x + 40 hex chars).', 'error');
            return;
        }
        if (newAddr.toLowerCase() === String(oldAddress || '').toLowerCase()) {
            showToast('⚠️ This is already your saved address.', 'warning');
            return;
        }

        const btn = document.getElementById('saveNewAddressBtn');
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Saving...`;

        try {
            const uid = state.user && state.user.uid;
            if (!uid) throw new Error('Session issue. Please refresh the page.');

            await saveWithdrawalAddress(uid, newAddr);
            addressChangeMode = false;
            showToast('✅ Wallet address updated successfully.', 'success');
            initializeWithdrawalAddressUI();
        } catch (err) {
            console.error('Save address error:', err);
            showToast('❌ ' + (err.message || 'Could not save address. Please try again.'), 'error');
            btn.disabled = false;
            btn.innerHTML = orig;
        }
    };

    addressChangeMode = true;
}

// ============================================================
// 🔥 WITHDRAW FORM HANDLER
// ============================================================
function attachWithdrawHandler(user) {
    const form = document.getElementById('withdrawForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (isSubmitting) {
            showToast('⏳ Please wait, your request is already being processed...', 'warning');
            return;
        }

        const walletType = document.getElementById('selectedWallet').value;
        const amountString = String(document.getElementById('withAmount').value || '').trim();

        const cfg = WITHDRAW_CONFIG[walletType];
        if (!cfg) {
            showToast('❌ Invalid wallet selected.', 'error');
            return;
        }

        if (!AMOUNT_REGEX.test(amountString)) {
            const tooLong = /^\d+\.\d{9,}$/.test(amountString);
            showToast(tooLong
                ? '❌ Maximum 8 decimal places are allowed.'
                : '❌ Please enter a valid amount greater than 0.', 'error');
            return;
        }

        const amount = Number(amountString);
        if (!Number.isFinite(amount) || amount <= 0) {
            showToast('❌ Please enter a valid amount greater than 0.', 'error');
            return;
        }

        if (amount < cfg.min) {
            showToast(`❌ Minimum withdrawal for ${cfg.label} is ${cfg.min} ${cfg.currency} (BEP20).`, 'error');
            return;
        }

        // Resolve address
        let address = '';
        if (savedAddress && !addressChangeMode) {
            address = savedAddress;
        } else {
            const inputEl = document.getElementById('withAddr');
            address = inputEl ? inputEl.value.trim() : '';
        }

        if (!BEP20_REGEX.test(address)) {
            showToast('❌ Please enter a valid BEP20 wallet address.', 'error');
            return;
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            showToast('📡 You are offline. Please check your internet connection and try again.', 'error');
            return;
        }

        const saveAddr = !!document.getElementById('saveWithdrawalAddress')?.checked;

        isSubmitting = true;
        setBusy(true);

        // Cheap pre-checks: 2 tiny reads (balance + lock)
        let settings;
        try {
            const [freshBalance, lockSnap] = await Promise.all([
                withTimeout(getBalance(user.uid, walletType)),
                withTimeout(get(ref(db, lockPath(user.uid))))
            ]);

            const lock = lockSnap.exists() ? lockSnap.val() : null;
            if (lock && lock.createdAt && Date.now() - lock.createdAt < LOCK_TTL) {
                showToast('Withdrawal already processing.', 'warning');
                releaseSubmit();
                return;
            }

            if (freshBalance < amount) {
                showToast(`❌ Insufficient balance! You have only ${freshBalance.toFixed(4)} ${cfg.currency}.`, 'error');
                releaseSubmit();
                return;
            }

            settings = await getWithdrawalSettings(user.uid);
        } catch (err) {
            console.error('Pre-check error:', err);
            showToast('❌ Unable to verify your balance. Please check your connection and try again.', 'error');
            releaseSubmit();
            return;
        }

        const hasPassword = !!(settings.passwordHash && String(settings.passwordHash).trim());

        openWithdrawPasswordModal(user.uid, {
            mode: hasPassword ? 'verify' : 'set',
            onCancel: () => { releaseSubmit(); },
            onSuccess: async () => {
                try {
                    await runWithdrawal(user, { walletType, amount, address, cfg, saveAddr });
                } catch (err) {
                    console.error('Withdrawal error:', err);
                    showToast('⚠️ Unexpected error. If your balance changed, DO NOT submit again — refresh the page to check.', 'warning', 9000);
                } finally {
                    releaseSubmit();
                }
            }
        });
    });
}

// ============================================================
// 🔥 REFRESH UI (local state only — zero downloads)
// ============================================================
function refreshUI() {
    renderWithdrawalUI();
    attachOptionHandlers();
    attachWithdrawHandler(state.user);
    initializeWithdrawalAddressUI();
}

function fillSidebar(userData) {
    const username = String(userData.username || userData.referralCode || 'USER');
    const name = String(userData.name || 'User');
    const sidebarName = document.getElementById('sidebarName');
    const sidebarUserId = document.getElementById('sidebarUserId');
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const referralBadge = document.getElementById('referralBadge');

    if (sidebarName) sidebarName.textContent = name;
    if (sidebarUserId) sidebarUserId.textContent = 'ID: ' + username.substring(0, 20) + (username.length > 20 ? '...' : '');
    if (sidebarAvatar) sidebarAvatar.textContent = name.charAt(0).toUpperCase();
    if (referralBadge) referralBadge.textContent = userData.totalReferrals || 0;
}

// ============================================================
// 🔥 MAIN
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    if (state.initUid === user.uid) return;   // avoid duplicate init / duplicate downloads
    state.initUid = user.uid;

    try {
        // Recover any interrupted withdrawal first (1 tiny read normally)
        try {
            await reconcileActiveWithdrawal(user.uid);
        } catch (err) {
            console.warn('Reconcile skipped:', err);
        }

        const [userData, , withdrawals] = await Promise.all([
            getUserSummary(user.uid),
            getWithdrawalSettings(user.uid, true),
            getWithdrawalHistory(user.uid)
        ]);

        if (!userData) {
            window.location.href = 'dashboard.html';
            return;
        }

        state.user = user;
        state.userData = userData;
        state.withdrawals = withdrawals;

        fillSidebar(userData);
        refreshUI();
        attachPasswordEyeToggles();

    } catch (error) {
        state.initUid = null;
        console.error('Error loading withdrawal page:', error);
        const container = document.getElementById('withdrawalContent');
        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 60px 20px;">
                    <i class="bi bi-exclamation-triangle" style="color:var(--red);opacity:0.8;"></i>
                    <h4 style="color:#fff;margin-bottom:8px;">Error Loading Page</h4>
                    <p style="color:var(--text-muted);margin-bottom:20px;">
                        ${escapeHtml(error.message || 'Please check your internet connection.')}
                    </p>
                    <button class="btn-primary-custom" onclick="location.reload()" style="max-width:200px;margin:0 auto;">
                        <i class="bi bi-arrow-clockwise"></i> Refresh Page
                    </button>
                </div>
            `;
        }
    }
});
