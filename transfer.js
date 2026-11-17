// ============================================================
// TRANSFER.JS — v9.0
// - ATOMIC transfer: एक ही multi-path update में sender debit + recipient credit
//   + history + request record (या तो सब होगा, या कुछ नहीं)
// - Offline / network error पर कुछ नहीं कटता
// - कोई partial state नहीं → rollback / reconciliation loop की ज़रूरत नहीं
// - Firebase download बहुत कम: पूरा users/{uid} node कभी डाउनलोड नहीं होता
// - XSS fix (user-controlled names escape किए गए)
// - UI / design / element IDs बिल्कुल पहले जैसे
// ============================================================

import { initializeApp } from "firebase/app";
import {
    getAuth,
    onAuthStateChanged,
    EmailAuthProvider,
    reauthenticateWithCredential,
    signOut
} from "firebase/auth";
import {
    getDatabase,
    ref,
    get,
    runTransaction,
    update,
    onValue,
    increment,
    query,
    orderByChild,
    equalTo,
    limitToFirst,
    limitToLast
} from "firebase/database";

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
// Config
// ============================================================
const WALLET_CURRENCY = { depositWallet: 'USDT', referralWallet: 'USDT', rndWallet: 'RND' };
const WALLET_PRECISION = { depositWallet: 2, referralWallet: 2, rndWallet: 8 };

const ACTIVE_REQUESTS_KEY = 'activeTransferRequestIds';
const WRITE_TIMEOUT_MS = 20000;               // इससे ज़्यादा लगे तो "confirming" mode
const LEGACY_MIN_AGE_MS = 2 * 60 * 1000;      // पुराने (v8) pending requests को छूने से पहले इंतज़ार
const MANUAL_REVIEW_AGE_MS = 30 * 60 * 1000;
const KEY_SAFE = /^[A-Za-z0-9_-]{1,128}$/;    // Firebase path में सिर्फ safe keys

// ============================================================
// State
// ============================================================
let currentUserId = null;
let currentProfile = null;           // { name, username, referralCode }
let currentBalances = { depositWallet: 0, referralWallet: 0, rndWallet: 0 };
let transferLock = false;
let transferBusy = false;
let pendingTransfer = null;
let modalOpen = false;
let isConnected = false;
let verifyingPending = false;
let initialized = false;
const inflight = new Set();          // इस session में भेजे गए, अभी confirm नहीं हुए requestIds
const unsubscribers = [];

// Password attempts throttle (client-side)
let pwdFails = 0;
let pwdLockUntil = 0;

// ============================================================
// Helpers
// ============================================================
function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 👁️ Eye toggle
// ============================================================
window.togglePassword = function (inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const icon = btn.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        if (icon) icon.className = 'bi bi-eye-slash';
    } else {
        input.type = 'password';
        if (icon) icon.className = 'bi bi-eye';
    }
};

// ============================================================
// 🌐 Connection (Firebase की असली connection state)
// ============================================================
function isOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
}

onValue(ref(db, '.info/connected'), (snap) => {
    const was = isConnected;
    isConnected = snap.val() === true;
    if (!was && isConnected && currentUserId && getActiveRequestIds().length > 0) {
        verifyPendingTransfersOnLoad();
    }
});

function waitForConnection(timeoutMs = 6000) {
    if (isConnected && isOnline()) return Promise.resolve(true);
    return new Promise((resolve) => {
        const start = Date.now();
        const t = setInterval(() => {
            if (isConnected && isOnline()) { clearInterval(t); resolve(true); }
            else if (Date.now() - start >= timeoutMs) { clearInterval(t); resolve(false); }
        }, 200);
    });
}

// ============================================================
// 🔐 Hash
// ============================================================
async function hashPassword(password) {
    const data = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// 🔑 Active request tracking (localStorage)
// ============================================================
function getActiveRequestIds() {
    try {
        const raw = localStorage.getItem(ACTIVE_REQUESTS_KEY);
        if (!raw) {
            const legacy = localStorage.getItem('activeTransferRequestId');
            if (legacy) {
                const arr = [legacy];
                localStorage.setItem(ACTIVE_REQUESTS_KEY, JSON.stringify(arr));
                localStorage.removeItem('activeTransferRequestId');
                return arr;
            }
            return [];
        }
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function addActiveRequestId(id) {
    try {
        const arr = getActiveRequestIds();
        if (!arr.includes(id)) arr.push(id);
        localStorage.setItem(ACTIVE_REQUESTS_KEY, JSON.stringify(arr));
    } catch { /* ignore */ }
}

function removeActiveRequestId(id) {
    try {
        const arr = getActiveRequestIds().filter(x => x !== id);
        if (arr.length) localStorage.setItem(ACTIVE_REQUESTS_KEY, JSON.stringify(arr));
        else localStorage.removeItem(ACTIVE_REQUESTS_KEY);
    } catch { /* ignore */ }
}

function createNewRequestId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

// ============================================================
// Toast (XSS-safe)
// ============================================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) {
        console.log(`[Toast ${type}]`, message);
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = document.createElement('i');
    icon.className = 'bi ' + (type === 'success'
        ? 'bi-check-circle-fill text-success'
        : 'bi-exclamation-triangle-fill text-danger');
    const span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = message;
    toast.appendChild(icon);
    toast.appendChild(span);
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ============================================================
// Precision helpers
// ============================================================
function roundToPrecision(v, p) {
    const f = Math.pow(10, p);
    return Math.round((v + Number.EPSILON) * f) / f;
}

function validateAmount(amount, walletType) {
    if (typeof amount !== 'number' || !isFinite(amount) || Number.isNaN(amount))
        return { valid: false, error: 'Invalid amount' };
    if (amount <= 0) return { valid: false, error: 'Amount must be > 0' };
    const precision = WALLET_PRECISION[walletType];
    if (precision === undefined) return { valid: false, error: 'Invalid wallet' };
    const rounded = roundToPrecision(amount, precision);
    if (rounded <= 0) return { valid: false, error: 'Amount too small' };
    if (Math.abs(rounded - amount) > 1e-10)
        return { valid: false, error: `Max ${precision} decimal places` };
    return { valid: true, value: rounded };
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================
// 👤 User lookup — सिर्फ ज़रूरी छोटे fields पढ़ता है (पूरा user node नहीं)
// ============================================================
const PROFILE_FIELDS = ['name', 'username', 'referralCode', 'email'];

async function fetchProfile(uid) {
    if (!KEY_SAFE.test(uid)) return null;
    const snaps = await Promise.all(PROFILE_FIELDS.map(f => get(ref(db, `users/${uid}/${f}`))));
    if (!snaps.some(s => s.exists())) return null;
    const str = (s) => (typeof s.val() === 'string' ? s.val() : undefined);
    return { name: str(snaps[0]), username: str(snaps[1]), referralCode: str(snaps[2]) };
}

function extractUid(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.uid || v.userId || null;
    return null;
}

async function resolveRecipient(identifier) {
    try {
        identifier = (identifier || '').trim();
        if (!identifier || identifier.length > 64) return null;
        const lower = identifier.toLowerCase();
        const upper = identifier.toUpperCase();

        // 1. Direct UID (4 छोटे reads)
        if (KEY_SAFE.test(identifier)) {
            const p = await fetchProfile(identifier);
            if (p) return { uid: identifier, profile: p };
        }

        // 2. usernames / referralCodes नोड (अगर uid map है तो सस्ता है)
        const mapPaths = [...new Set([
            `usernames/${lower}`, `usernames/${identifier}`,
            `referralCodes/${identifier}`, `referralCodes/${upper}`
        ])].filter(p => KEY_SAFE.test(p.split('/')[1]));

        const mapSnaps = await Promise.all(mapPaths.map(p => get(ref(db, p)).catch(() => null)));
        for (const s of mapSnaps) {
            if (!s || !s.exists()) continue;
            const uid = extractUid(s.val());
            if (uid && KEY_SAFE.test(uid)) {
                const p = await fetchProfile(uid);
                // mapping सिर्फ तब मानी जाए जब उस user का username/referralCode सच में वही हो
                const matches = p && [p.username, p.referralCode].some(
                    (x) => typeof x === 'string' && x.toLowerCase() === lower
                );
                if (matches) return { uid, profile: p };
            }
        }

        // 3. Indexed query (rules में username / referralCode indexed है) — सिर्फ 1 result
        const attempts = [];
        const seen = new Set();
        [['username', identifier], ['referralCode', identifier],
         ['username', lower], ['referralCode', upper], ['referralCode', lower]].forEach(([f, v]) => {
            const k = f + '|' + v;
            if (!seen.has(k)) { seen.add(k); attempts.push([f, v]); }
        });

        for (const [field, value] of attempts) {
            const snap = await get(query(ref(db, 'users'), orderByChild(field), equalTo(value), limitToFirst(2)));
            if (snap.exists()) {
                // एक से ज़्यादा user मिले → गलत इंसान को पैसा न जाए, UID से भेजने को कहें
                if (snap.numChildren() > 1) return { ambiguous: true };
                let found = null;
                snap.forEach((child) => {
                    const v = child.val() || {};
                    found = {
                        uid: child.key,
                        profile: {
                            name: typeof v.name === 'string' ? v.name : undefined,
                            username: typeof v.username === 'string' ? v.username : undefined,
                            referralCode: typeof v.referralCode === 'string' ? v.referralCode : undefined
                        }
                    };
                    return true;
                });
                if (found) return found;
            }
        }
        return null;
    } catch (error) {
        console.error('Lookup error:', error);
        return null;
    }
}

function getUserDisplayName(profile, fallbackUid) {
    const short = fallbackUid ? fallbackUid.slice(0, 8) : 'Unknown';
    if (!profile) return short;
    return profile.name || profile.username || profile.referralCode || short;
}

// ============================================================
// 🔐 Password management
// ============================================================
async function hasTransferPassword(uid) {
    try {
        const snap = await get(ref(db, `users/${uid}/transferPasswordHash`));
        return snap.exists() && !!snap.val();
    } catch { return false; }
}

async function saveTransferPassword(uid, password) {
    const hash = await hashPassword(password);
    await update(ref(db, `users/${uid}`), {
        transferPasswordHash: hash,
        transferPasswordSetAt: Date.now()
    });
}

async function verifyTransferPassword(uid, password) {
    try {
        const snap = await get(ref(db, `users/${uid}/transferPasswordHash`));
        if (!snap.exists()) return false;
        return snap.val() === await hashPassword(password);
    } catch { return false; }
}

// ============================================================
// 🚀 ATOMIC TRANSFER
// एक ही update() में सब कुछ — Firebase इसे all-or-nothing लिखता है।
// ============================================================
async function atomicTransfer(p) {
    const { senderUid, recipientUid, walletType, currency, requestId, senderName, recipientName } = p;

    if (!senderUid || !recipientUid) return { status: 'failed', error: 'Missing IDs' };
    if (!KEY_SAFE.test(senderUid) || !KEY_SAFE.test(recipientUid)) return { status: 'failed', error: 'Invalid user ID' };
    if (senderUid === recipientUid) return { status: 'failed', error: 'Cannot send to yourself' };
    if (!WALLET_CURRENCY[walletType]) return { status: 'failed', error: 'Invalid wallet' };

    const amountCheck = validateAmount(p.amount, walletType);
    if (!amountCheck.valid) return { status: 'failed', error: amountCheck.error };
    const safeAmount = amountCheck.value;

    // STEP 0: connection ज़रूरी — नहीं है तो कुछ नहीं कटेगा
    if (!(await waitForConnection(6000))) {
        return { status: 'failed', error: 'No internet connection. कुछ नहीं कटा।' };
    }

    // STEP 1: ताज़ा balance (सिर्फ एक छोटा number)
    let balance;
    try {
        const s = await get(ref(db, `users/${senderUid}/${walletType}`));
        balance = Number(s.val() || 0);
    } catch (err) {
        console.error('Balance read error:', err);
        return { status: 'failed', error: 'Network error. कुछ नहीं कटा।' };
    }
    if (!isFinite(balance)) return { status: 'failed', error: 'Invalid balance' };
    if (balance + 1e-9 < safeAmount) {
        return {
            status: 'failed',
            error: `Insufficient balance. Available: ${balance} ${currency}. कुछ नहीं कटा।`
        };
    }
    // पूरा balance भेजते समय floating-point noise से balance negative न हो
    const debitAmount = Math.abs(balance - safeAmount) < 1e-9 ? balance : safeAmount;

    // STEP 2: सब कुछ एक atomic update में
    const now = Date.now();
    const txId = 'TX_' + requestId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    const today = getTodayDate();

    const updates = {};
    updates[`users/${senderUid}/${walletType}`] = increment(-debitAmount);
    updates[`users/${recipientUid}/${walletType}`] = increment(safeAmount);

    updates[`users/${senderUid}/transferHistory/${txId}`] = {
        type: 'sent',
        to: recipientName, toUid: recipientUid, toUsername: recipientName,
        amount: safeAmount, currency, walletType,
        from: senderName, fromUid: senderUid, fromUsername: senderName,
        timestamp: now, txId, requestId, status: 'completed'
    };
    updates[`users/${senderUid}/transactions/${txId}`] = {
        type: 'transfer_sent', amount: safeAmount, currency, walletType,
        to: recipientName, toUid: recipientUid, toUsername: recipientName,
        from: senderName, fromUid: senderUid,
        timestamp: now, date: today, txId, requestId, status: 'completed'
    };
    updates[`users/${recipientUid}/transferHistory/${txId}`] = {
        type: 'received',
        from: senderName, fromUid: senderUid, fromUsername: senderName,
        to: recipientName, toUid: recipientUid, toUsername: recipientName,
        amount: safeAmount, currency, walletType,
        timestamp: now, txId, requestId, status: 'completed'
    };
    updates[`users/${recipientUid}/transactions/${txId}`] = {
        type: 'transfer_received', amount: safeAmount, currency, walletType,
        from: senderName, fromUid: senderUid,
        to: recipientName, toUid: recipientUid,
        timestamp: now, date: today, txId, requestId, status: 'completed'
    };
    updates[`transferRequests/${requestId}`] = {
        v: 9, requestId, txId, senderUid, recipientUid,
        amount: safeAmount, currency, walletType,
        status: 'success', createdAt: now, completedAt: now
    };

    inflight.add(requestId);
    const settled = update(ref(db), updates).then(
        () => ({ ok: true }),
        (err) => ({ ok: false, err })
    );

    const first = await Promise.race([settled, sleep(WRITE_TIMEOUT_MS).then(() => null)]);

    if (first && first.ok) {
        inflight.delete(requestId);
        return { status: 'success', txId, recipientName };
    }

    if (first && !first.ok) {
        // Reject हुआ = server ने कुछ नहीं लिखा (atomic) → कुछ नहीं कटा
        inflight.delete(requestId);
        console.error('Transfer rejected:', first.err);
        return { status: 'failed', error: friendlyWriteError(first.err) };
    }

    // Timeout: network धीमा/टूटा। Write अभी queue में है — बाद में या तो पूरा होगा या reject होगा।
    const pending = settled.then((r) => {
        inflight.delete(requestId);
        return r.ok
            ? { status: 'success', txId, recipientName }
            : { status: 'failed', error: friendlyWriteError(r.err) };
    });
    return { status: 'unknown', txId, pending, error: 'Confirming...' };
}

function friendlyWriteError(err) {
    const code = (err && (err.code || err.message)) || '';
    if (String(code).toUpperCase().includes('PERMISSION')) {
        return 'Transfer allowed नहीं हुआ (balance कम हो सकता है)। कुछ नहीं कटा।';
    }
    return 'Network error. कुछ नहीं कटा।';
}

// ============================================================
// 🧹 पुराने (v8) अधूरे requests का सुरक्षित निपटारा
// ============================================================
async function patchRequest(requestRef, patch) {
    try {
        await update(requestRef, { ...patch, updatedAt: Date.now() });
        return true;
    } catch (err) {
        console.warn('patchRequest failed:', err);
        return false;
    }
}

async function resolveLegacyRequest(requestId, d) {
    if (!d || d.senderUid !== currentUserId) return 'skip';
    const reqRef = ref(db, `transferRequests/${requestId}`);
    const createdAt = d.createdAt || 0;
    const age = Date.now() - createdAt;

    if (!d.txId || !KEY_SAFE.test(d.txId) || !KEY_SAFE.test(d.recipientUid || '') ||
        !WALLET_CURRENCY[d.walletType] || typeof d.amount !== 'number') {
        await patchRequest(reqRef, { needsManualReview: true });
        return 'manual';
    }
    if (age < LEGACY_MIN_AGE_MS) return 'wait';

    const [sSnap, rSnap] = await Promise.all([
        get(ref(db, `users/${d.senderUid}/transferHistory/${d.txId}`)),
        get(ref(db, `users/${d.recipientUid}/transferHistory/${d.txId}`))
    ]);
    const s = sSnap.exists() ? sSnap.val() : null;
    const r = rSnap.exists() ? rSnap.val() : null;

    // Recipient को मिल गया → success
    if (r && r.status === 'completed' && !(s && s.status === 'reversed')) {
        await patchRequest(reqRef, { status: 'success', completedAt: Date.now(), resolvedBy: 'v9_legacy' });
        return 'success';
    }
    // किसी को कुछ नहीं हुआ → failed
    if (!s && !r) {
        await patchRequest(reqRef, { status: 'failed', failedAt: Date.now(), reason: 'Neither wallet touched', resolvedBy: 'v9_legacy' });
        return 'failed';
    }
    // Sender कटा, recipient को नहीं मिला → refund (एक ही बार, claim के साथ)
    if (s && s.status === 'completed' && !r) {
        const claim = await runTransaction(reqRef, (cur) => {
            if (cur === null) return null;
            if (cur.status !== 'pending' && cur.status !== 'unknown') return;
            return { ...cur, status: 'refunding', refundClaimedAt: Date.now() };
        });
        const claimed = claim.snapshot.val();
        if (!claim.committed || !claimed || claimed.status !== 'refunding') return 'wait';

        // Recipient को एक बार फिर check
        const recheck = await get(ref(db, `users/${d.recipientUid}/transferHistory/${d.txId}`));
        if (recheck.exists()) {
            await patchRequest(reqRef, { status: 'success', completedAt: Date.now(), resolvedBy: 'v9_legacy_recheck' });
            return 'success';
        }

        const now = Date.now();
        const upd = {};
        upd[`users/${d.senderUid}/${d.walletType}`] = increment(d.amount);
        upd[`users/${d.senderUid}/transferHistory/${d.txId}/status`] = 'reversed';
        upd[`users/${d.senderUid}/transferHistory/${d.txId}/reversedAt`] = now;
        upd[`users/${d.senderUid}/transferHistory/${d.txId}/reversedReason`] = 'recipient_missing';
        upd[`users/${d.senderUid}/transactions/${d.txId}/status`] = 'reversed';
        upd[`transferRequests/${requestId}/status`] = 'failed';
        upd[`transferRequests/${requestId}/failedAt`] = now;
        upd[`transferRequests/${requestId}/reason`] = 'Refunded — recipient never credited';
        upd[`transferRequests/${requestId}/resolvedBy`] = 'v9_legacy_refund';
        try {
            await update(ref(db), upd);
            return 'failed';
        } catch (err) {
            console.error('Legacy refund failed:', err);
            await patchRequest(reqRef, { status: 'unknown' });
            return 'wait';
        }
    }

    if (age > MANUAL_REVIEW_AGE_MS) {
        await patchRequest(reqRef, { needsManualReview: true, lastCheckedAt: Date.now() });
        return 'manual';
    }
    await patchRequest(reqRef, { needsManualReview: true, lastCheckedAt: Date.now(), lastError: 'Mixed state — manual review' });
    return 'manual';
}

// ============================================================
// On-Load / reconnect verification (हल्के reads, सिर्फ request नोड)
// ============================================================
async function verifyPendingTransfersOnLoad() {
    if (verifyingPending) return;
    verifyingPending = true;
    try {
        const ids = getActiveRequestIds();
        for (const requestId of ids) {
            if (inflight.has(requestId)) continue;      // अभी इसी session में confirm हो रहा है
            if (!KEY_SAFE.test(requestId)) { removeActiveRequestId(requestId); continue; }
            try {
                const snap = await get(ref(db, `transferRequests/${requestId}`));
                if (!snap.exists()) {
                    // Server पर कभी पहुँचा ही नहीं → कुछ नहीं कटा
                    removeActiveRequestId(requestId);
                    continue;
                }
                const data = snap.val();
                if (data.status === 'success') {
                    showToast('✅ Previous transfer confirmed!', 'success');
                    removeActiveRequestId(requestId);
                    continue;
                }
                if (data.status === 'failed') {
                    showToast('❌ Previous transfer failed.', 'error');
                    removeActiveRequestId(requestId);
                    continue;
                }
                // पुराने v8 format के pending/unknown
                const res = await resolveLegacyRequest(requestId, data);
                if (res === 'success') { showToast('✅ Transfer confirmed!', 'success'); removeActiveRequestId(requestId); }
                else if (res === 'failed') { showToast('❌ Transfer failed — amount refunded.', 'error'); removeActiveRequestId(requestId); }
                else if (res === 'manual') { showToast('⚠️ Transfer needs manual review. Support से संपर्क करें।', 'error'); removeActiveRequestId(requestId); }
            } catch (err) {
                console.warn(`Verify error for ${requestId}:`, err); // offline → बाद में फिर try होगा
            }
        }
    } finally {
        verifyingPending = false;
    }
}

// ============================================================
// Modal Controls
// ============================================================
function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
    modalOpen = true;
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
    modalOpen = false;

    if (id === 'setupModal') {
        ['setupPassword', 'setupPasswordConfirm'].forEach(eid => {
            const el = document.getElementById(eid);
            if (el) { el.value = ''; el.type = 'password'; }
        });
        document.querySelectorAll('#setupModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('setupError')?.classList.remove('show');
    }
    if (id === 'verifyModal') {
        const el = document.getElementById('verifyPassword');
        if (el) { el.value = ''; el.type = 'password'; }
        document.querySelectorAll('#verifyModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('verifyError')?.classList.remove('show');
    }
    if (id === 'forgotModal') {
        ['forgotAccountPassword', 'forgotNewPassword', 'forgotNewPasswordConfirm'].forEach(eid => {
            const el = document.getElementById(eid);
            if (el) { el.value = ''; el.type = 'password'; }
        });
        document.querySelectorAll('#forgotModal .password-eye i').forEach(i => i.className = 'bi bi-eye');
        document.getElementById('forgotError1')?.classList.remove('show');
        document.getElementById('forgotError2')?.classList.remove('show');
        document.getElementById('forgotStep1')?.classList.add('active');
        document.getElementById('forgotStep2')?.classList.remove('active');
    }
}

// ============================================================
// Password Setup
// ============================================================
function openPasswordSetup() {
    openModal('setupModal');
    setTimeout(() => document.getElementById('setupPassword')?.focus(), 200);
}

async function handlePasswordSetup() {
    const pwd = document.getElementById('setupPassword').value;
    const confirm = document.getElementById('setupPasswordConfirm').value;
    const errorEl = document.getElementById('setupError');
    const btn = document.getElementById('setupBtn');
    errorEl.classList.remove('show');

    if (!pwd || pwd.length < 6) {
        errorEl.textContent = 'Password कम से कम 6 characters का हो';
        errorEl.classList.add('show');
        return;
    }
    if (pwd !== confirm) {
        errorEl.textContent = 'दोनों passwords match नहीं कर रहे';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Setting...';

    try {
        await saveTransferPassword(currentUserId, pwd);
        showToast('✅ Password set! अब फिर Send दबाओ।', 'success');
        closeModal('setupModal');
        pendingTransfer = null;
    } catch (err) {
        console.error('Save error:', err);
        errorEl.textContent = 'Password save नहीं हुआ।';
        errorEl.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Set Password';
    }
}

// ============================================================
// Password Verify
// ============================================================
function openPasswordVerify(details) {
    pendingTransfer = details;
    const detailsEl = document.getElementById('verifyDetails');

    let walletClass = 'deposit';
    let walletIcon = 'bi-wallet2';
    if (details.walletType === 'referralWallet') { walletClass = 'referral'; walletIcon = 'bi-coin'; }
    if (details.walletType === 'rndWallet') { walletClass = 'rnd'; walletIcon = 'bi-database'; }

    detailsEl.innerHTML = `
        <div class="verify-row">
            <span class="label"><i class="bi bi-person-fill"></i> From:</span>
            <span class="value name">${escapeHtml(details.senderName || 'You')}</span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-wallet2"></i> From Wallet:</span>
            <span class="verify-wallet-badge ${walletClass}">
                <i class="bi ${walletIcon}"></i> ${escapeHtml(details.walletLabel)}
            </span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-person-check-fill"></i> To:</span>
            <span class="value name">${escapeHtml(details.recipientName)}</span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-wallet2"></i> To Wallet:</span>
            <span class="verify-wallet-badge ${walletClass}">
                <i class="bi ${walletIcon}"></i> ${escapeHtml(details.walletLabel)}
            </span>
        </div>
        <div class="verify-row">
            <span class="label"><i class="bi bi-currency-dollar"></i> Amount:</span>
            <span class="value amount">${escapeHtml(details.amount)} ${escapeHtml(details.currency)}</span>
        </div>
    `;
    openModal('verifyModal');
    setTimeout(() => document.getElementById('verifyPassword')?.focus(), 200);
}

async function handlePasswordVerify() {
    const password = document.getElementById('verifyPassword').value;
    const errorEl = document.getElementById('verifyError');
    const btn = document.getElementById('verifyBtn');
    errorEl.classList.remove('show');

    if (Date.now() < pwdLockUntil) {
        const secs = Math.ceil((pwdLockUntil - Date.now()) / 1000);
        errorEl.textContent = `बहुत गलत attempts। ${secs} सेकंड बाद try करें।`;
        errorEl.classList.add('show');
        return;
    }
    if (!password) {
        errorEl.textContent = 'Password डालें';
        errorEl.classList.add('show');
        return;
    }
    if (!pendingTransfer) {
        errorEl.textContent = 'Transfer details missing. दोबारा Send दबाओ।';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Verifying...';

    try {
        const isValid = await verifyTransferPassword(currentUserId, password);
        if (!isValid) {
            pwdFails++;
            if (pwdFails >= 5) { pwdLockUntil = Date.now() + 60000; pwdFails = 0; }
            errorEl.textContent = '❌ Password गलत है';
            errorEl.classList.add('show');
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';
            return;
        }
        pwdFails = 0;

        const details = pendingTransfer;
        closeModal('verifyModal');

        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';

        await executeTransfer(details);
    } catch (err) {
        console.error('Verify error:', err);
        errorEl.textContent = 'Error आया।';
        errorEl.classList.add('show');
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify & Send';
    }
}

// ============================================================
// 🚀 EXECUTE TRANSFER
// ============================================================
async function executeTransfer(details) {
    const user = auth.currentUser;
    if (!user) { resetButton(); return; }
    if (transferBusy) return;
    transferBusy = true;
    transferLock = true;

    const btn = document.getElementById('sendBtn');
    if (btn) {
        btn.disabled = true;
        btn.className = 'btn-send sending';
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Sending...';
    }

    // requestId यहीं बनता है (cancel करने पर कोई कचरा नहीं बचता)
    const requestId = createNewRequestId();
    addActiveRequestId(requestId);

    try {
        const result = await atomicTransfer({
            senderUid: user.uid,
            recipientUid: details.recipient.uid,
            amount: details.amount,
            walletType: details.walletType,
            currency: details.currency,
            requestId,
            senderName: details.senderName,
            recipientName: details.recipientName
        });

        if (result.status === 'success') {
            showToast(`✅ ${details.amount} ${details.currency} sent to ${details.recipientName}!`, 'success');
            const r = document.getElementById('recipientInput'); if (r) r.value = '';
            const a = document.getElementById('amountInput'); if (a) a.value = '';
            removeActiveRequestId(requestId);
        } else if (result.status === 'unknown') {
            showToast('⚠️ Network धीमा है — transfer confirm हो रहा है। दोबारा Send न दबाएँ।', 'error');
            // UI unlock; background में confirm
            result.pending.then((final) => {
                if (final.status === 'success') {
                    showToast(`✅ ${details.amount} ${details.currency} sent to ${details.recipientName}!`, 'success');
                } else {
                    showToast('❌ ' + (final.error || 'Transfer failed'), 'error');
                }
                removeActiveRequestId(requestId);
            });
        } else {
            showToast('❌ ' + (result.error || 'Transfer failed'), 'error');
            removeActiveRequestId(requestId);
        }
    } catch (err) {
        console.error('Execute error:', err);
        // requestId active में रहने दिया — अगली बार server से verify हो जाएगा
        showToast('⚠️ Unexpected error. Status verify हो रहा है।', 'error');
    } finally {
        resetButton();
    }
}

function resetButton() {
    const btn = document.getElementById('sendBtn');
    if (btn) {
        btn.disabled = false;
        btn.className = 'btn-send';
        btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
    }
    transferLock = false;
    transferBusy = false;
    pendingTransfer = null;
}

// ============================================================
// FORGOT PASSWORD — Step 1
// ============================================================
async function handleForgotVerify() {
    const password = document.getElementById('forgotAccountPassword').value;
    const errorEl = document.getElementById('forgotError1');
    const btn = document.getElementById('forgotVerifyBtn');
    errorEl.classList.remove('show');

    if (!password) {
        errorEl.textContent = 'Account password डालें';
        errorEl.classList.add('show');
        return;
    }

    const user = auth.currentUser;
    if (!user || !user.email) {
        errorEl.textContent = 'User email नहीं मिला। Support से संपर्क करें।';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Verifying...';

    try {
        const credential = EmailAuthProvider.credential(user.email, password);
        await reauthenticateWithCredential(user, credential);

        document.getElementById('forgotStep1').classList.remove('active');
        document.getElementById('forgotStep2').classList.add('active');
        document.getElementById('forgotAccountPassword').value = '';
        setTimeout(() => document.getElementById('forgotNewPassword')?.focus(), 200);
    } catch (err) {
        console.error('Forgot verify error:', err);
        let msg = '❌ Account password गलत है';
        if (err.code === 'auth/too-many-requests') {
            msg = 'बहुत बार try किया। थोड़ी देर बाद try करें।';
        } else if (err.code === 'auth/network-request-failed') {
            msg = 'Network error। Internet check करें।';
        }
        errorEl.textContent = msg;
        errorEl.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify';
    }
}

// ============================================================
// FORGOT PASSWORD — Step 2
// ============================================================
async function handleForgotReset() {
    const pwd = document.getElementById('forgotNewPassword').value;
    const confirm = document.getElementById('forgotNewPasswordConfirm').value;
    const errorEl = document.getElementById('forgotError2');
    const btn = document.getElementById('forgotResetBtn');
    errorEl.classList.remove('show');

    if (!pwd || pwd.length < 6) {
        errorEl.textContent = 'Password कम से कम 6 characters का हो';
        errorEl.classList.add('show');
        return;
    }
    if (pwd !== confirm) {
        errorEl.textContent = 'दोनों passwords match नहीं कर रहे';
        errorEl.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner me-2"></span>Saving...';

    try {
        await saveTransferPassword(currentUserId, pwd);
        showToast('✅ Transfer password reset successfully!', 'success');
        closeModal('forgotModal');
        pendingTransfer = null;
    } catch (err) {
        console.error('Reset error:', err);
        errorEl.textContent = 'Password save नहीं हुआ।';
        errorEl.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Set New Password';
    }
}

// ============================================================
// Form Submit
// ============================================================
function getWalletLabel(w) {
    if (w === 'depositWallet') return '💰 Deposit Wallet';
    if (w === 'referralWallet') return '💳 Referral Wallet';
    if (w === 'rndWallet') return '📊 RND Wallet';
    return w;
}

async function handleTransferSubmit(e) {
    e.preventDefault();
    if (modalOpen) return;
    if (transferLock) {
        showToast('⏳ Transfer in progress...', 'error');
        return;
    }
    transferLock = true;

    const btn = document.getElementById('sendBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="loading-spinner me-2"></span>Checking...';
    }

    try {
        // 🌐 Connection pre-check
        if (!(await waitForConnection(3000))) {
            showToast('❌ No internet connection. कुछ नहीं कटा।', 'error');
            resetButton();
            return;
        }

        const recipientInput = document.getElementById('recipientInput').value.trim();
        const walletType = document.getElementById('walletSelect').value;
        const amountRaw = document.getElementById('amountInput').value.trim();

        if (!recipientInput) { showToast('❌ Enter recipient', 'error'); resetButton(); return; }
        if (!WALLET_CURRENCY[walletType]) { showToast('❌ Invalid wallet', 'error'); resetButton(); return; }

        const amount = Number(amountRaw);
        if (!amountRaw || !isFinite(amount) || Number.isNaN(amount) || amount <= 0) {
            showToast('❌ Valid amount डालें', 'error'); resetButton(); return;
        }
        const amountCheck = validateAmount(amount, walletType);
        if (!amountCheck.valid) { showToast('❌ ' + amountCheck.error, 'error'); resetButton(); return; }

        const user = auth.currentUser;
        if (!user) { showToast('❌ Please login', 'error'); resetButton(); return; }

        const currentBalance = currentBalances[walletType] || 0;
        if (currentBalance + 1e-9 < amountCheck.value) {
            showToast(`❌ Insufficient balance. Available: ${currentBalance} ${WALLET_CURRENCY[walletType]}`, 'error');
            resetButton(); return;
        }

        // पिछले अधूरे transfers (हल्का check)
        const activeIds = getActiveRequestIds();
        if (activeIds.length > 0) {
            if (activeIds.some(id => inflight.has(id))) {
                showToast('⚠️ Previous transfer अभी confirm हो रहा है। थोड़ा रुकें।', 'error');
                resetButton(); return;
            }
            await verifyPendingTransfersOnLoad();
            if (getActiveRequestIds().length > 0) {
                showToast('⚠️ Previous transfer still verifying. Wait.', 'error');
                resetButton(); return;
            }
        }

        const recipient = await resolveRecipient(recipientInput);
        if (!recipient) { showToast('❌ User not found!', 'error'); resetButton(); return; }
        if (recipient.ambiguous) {
            showToast('❌ इस नाम के कई users हैं। सामने वाले की User ID से भेजें।', 'error');
            resetButton(); return;
        }
        if (recipient.uid === user.uid) { showToast('❌ Cannot send to yourself!', 'error'); resetButton(); return; }

        const senderName = getUserDisplayName(currentProfile, user.uid);
        const recipientName = getUserDisplayName(recipient.profile, recipient.uid);

        const details = {
            recipient: { uid: recipient.uid },
            recipientName, senderName,
            amount: amountCheck.value, walletType,
            currency: WALLET_CURRENCY[walletType],
            walletLabel: getWalletLabel(walletType)
        };

        const hasPwd = await hasTransferPassword(user.uid);

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-send me-2"></i> Send Money';
        }
        transferLock = false;

        if (!hasPwd) {
            openPasswordSetup();
            return;
        }
        openPasswordVerify(details);

    } catch (err) {
        console.error('Submit error:', err);
        showToast('❌ Unexpected error', 'error');
        resetButton();
    }
}

// ============================================================
// Balance (सिर्फ 3 छोटे number listeners)
// ============================================================
function setupBalanceListeners(uid) {
    ['depositWallet', 'referralWallet', 'rndWallet'].forEach((w) => {
        const off = onValue(ref(db, `users/${uid}/${w}`), (snap) => {
            const n = Number(snap.val() || 0);
            currentBalances[w] = isFinite(n) ? n : 0;
            updateBalanceUI();
        }, (error) => console.error('Balance error:', error));
        unsubscribers.push(off);
    });
}

function updateBalanceUI() {
    const dep = document.getElementById('balanceDeposit');
    const refEl = document.getElementById('balanceReferral');
    const rnd = document.getElementById('balanceRND');
    if (dep) dep.textContent = '$' + (currentBalances.depositWallet || 0).toFixed(2);
    if (refEl) refEl.textContent = '$' + (currentBalances.referralWallet || 0).toFixed(2);
    if (rnd) rnd.textContent = (currentBalances.rndWallet || 0).toFixed(4) + ' RND';
    updateAvailableText();
}

function updateAvailableText() {
    const select = document.getElementById('walletSelect');
    if (!select) return;
    const walletType = select.value;
    const balance = currentBalances[walletType] || 0;
    const availText = document.getElementById('availableText');
    if (availText && WALLET_PRECISION[walletType] !== undefined)
        availText.textContent = balance.toFixed(WALLET_PRECISION[walletType]) + ' ' + WALLET_CURRENCY[walletType];
}

window.setMaxAmount = function () {
    const walletType = document.getElementById('walletSelect').value;
    const p = WALLET_PRECISION[walletType];
    if (p === undefined) return;
    const balance = currentBalances[walletType] || 0;
    const f = Math.pow(10, p);
    const v = Math.floor(balance * f + 1e-6) / f;   // ऊपर round नहीं, balance से ज़्यादा कभी नहीं
    document.getElementById('amountInput').value = v.toFixed(p);
};

// ============================================================
// Recent transfers (सिर्फ आखिरी 5 entries डाउनलोड)
// ============================================================
function renderRecentTransfers(arr) {
    const container = document.getElementById('recentTransfers');
    if (!container) return;

    arr = arr.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 5);

    if (arr.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: #64748b; padding: 20px; font-size: 0.85rem;"><i class="bi bi-clock"></i> No transfers yet</div>`;
        return;
    }

    container.innerHTML = arr.map(t => {
        const isSent = t.type === 'sent';
        const name = isSent ? (t.to || t.toUsername || 'Unknown') : (t.from || t.fromUsername || 'Unknown');
        const uid = isSent ? (t.toUid || '') : (t.fromUid || '');
        const sign = isSent ? '-' : '+';
        const cls = isSent ? 'transfer-sent' : 'transfer-received';
        const date = t.timestamp ? new Date(t.timestamp).toLocaleString('hi-IN') : '';
        const statusBadge = t.status === 'reversed'
            ? ' <span style="color:#f59e0b;font-size:0.7rem;">(reversed)</span>'
            : '';
        return `
            <div class="transfer-item">
                <div>
                    <div class="${cls}" style="font-size: 0.85rem;">
                        <i class="bi bi-arrow-${isSent ? 'up-right' : 'down-left'}"></i>
                        ${isSent ? 'Sent to' : 'Received from'}
                        <span class="transfer-name">${escapeHtml(name)}</span>${statusBadge}
                    </div>
                    ${uid ? `<div style="font-size: 0.7rem; color: #64748b; margin-top: 2px;">ID: ${escapeHtml(String(uid).slice(0, 12))}...</div>` : ''}
                    <div class="transfer-date">${escapeHtml(date)}</div>
                </div>
                <div class="transfer-amount ${cls}">${sign}${escapeHtml(t.amount)} ${escapeHtml(t.currency || 'RND')}</div>
            </div>
        `;
    }).join('');
}

function setupRecentListener(uid) {
    const q = query(ref(db, `users/${uid}/transferHistory`), orderByChild('timestamp'), limitToLast(5));
    const off = onValue(q, (snap) => {
        const arr = [];
        snap.forEach((c) => {
            const v = c.val();
            if (v && typeof v === 'object') arr.push(v);
        });
        renderRecentTransfers(arr);
    }, (error) => console.error('Recent transfers error:', error));
    unsubscribers.push(off);
}

// ============================================================
// Init
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    if (initialized) return;
    initialized = true;
    currentUserId = user.uid;

    let profile = null;
    try {
        profile = await fetchProfile(user.uid);
    } catch (err) {
        console.error('Profile error:', err);
    }
    if (!profile) {
        showToast('❌ User not found', 'error');
        setTimeout(() => window.location.href = 'dashboard.html', 2000);
        return;
    }
    currentProfile = profile;

    setupBalanceListeners(user.uid);
    setupRecentListener(user.uid);
    verifyPendingTransfersOnLoad();

    if (typeof window.__hideTransferLoader === 'function') {
        window.__hideTransferLoader();
    }

    const form = document.getElementById('transferForm');
    if (form) form.addEventListener('submit', handleTransferSubmit);

    document.getElementById('setupBtn')?.addEventListener('click', handlePasswordSetup);
    document.getElementById('setupPasswordConfirm')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handlePasswordSetup();
    });

    document.getElementById('verifyBtn')?.addEventListener('click', handlePasswordVerify);
    document.getElementById('verifyPassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handlePasswordVerify();
    });
    document.getElementById('verifyCancelBtn')?.addEventListener('click', () => {
        closeModal('verifyModal');
        pendingTransfer = null;
        resetButton();
    });

    document.getElementById('forgotPasswordBtn')?.addEventListener('click', () => {
        closeModal('verifyModal');
        openModal('forgotModal');
        setTimeout(() => document.getElementById('forgotAccountPassword')?.focus(), 200);
    });
    document.getElementById('forgotVerifyBtn')?.addEventListener('click', handleForgotVerify);
    document.getElementById('forgotAccountPassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleForgotVerify();
    });
    document.getElementById('forgotResetBtn')?.addEventListener('click', handleForgotReset);
    document.getElementById('forgotNewPasswordConfirm')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleForgotReset();
    });
    document.getElementById('forgotCancelBtn1')?.addEventListener('click', () => {
        closeModal('forgotModal');
        pendingTransfer = null;
        resetButton();
    });

    const select = document.getElementById('walletSelect');
    if (select) {
        const applyStep = () => {
            const amountInput = document.getElementById('amountInput');
            if (!amountInput) return;
            if (select.value === 'rndWallet') {
                amountInput.step = '0.00000001';
                amountInput.min = '0.00000001';
            } else {
                amountInput.step = '0.01';
                amountInput.min = '0.01';
            }
        };
        select.addEventListener('change', () => {
            updateAvailableText();
            applyStep();
        });
        applyStep();
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && getActiveRequestIds().length > 0) {
            verifyPendingTransfersOnLoad();
        }
    });

    window.addEventListener('online', () => {
        if (getActiveRequestIds().length > 0) {
            verifyPendingTransfersOnLoad();
        }
    });
});

// ============================================================
// Cleanup
// ============================================================
window.addEventListener('beforeunload', () => {
    unsubscribers.forEach((off) => { try { off(); } catch (_) {} });
    unsubscribers.length = 0;
});

// ============================================================
// 🔥 UI Logic (Loader & Sidebar) — unchanged
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const loader = document.getElementById('pageLoader');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 400);
            document.body.classList.remove('loading');
        }
    }, 1500);

    const sidebarPanel = document.getElementById('sidebarPanel');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarClose = document.getElementById('sidebarClose');

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            sidebarPanel.classList.add('open');
            sidebarOverlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        });
    }
    if (sidebarClose) {
        sidebarClose.addEventListener('click', () => {
            sidebarPanel.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            document.body.style.overflow = '';
        });
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
            sidebarPanel.classList.remove('open');
            sidebarOverlay.classList.remove('active');
            document.body.style.overflow = '';
        });
    }

    const logoutBtn = document.getElementById('logoutBtnSidebar');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await signOut(auth);
            } catch (err) {
                console.error('Logout error:', err);
            }
            window.location.href = 'login.html';
        });
    }
});
