// transactions.js - OPTIMIZED (LOW FIREBASE BANDWIDTH)
// Firebase v10 Modular SDK - Realtime Database
//
// IMPORTANT: Firebase Rules me ".indexOn": ["timestamp"] zaroor lagayein
// (users/$uid/transactions ke andar), warna query poora data download karegi.

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
    getDatabase, ref, get, onValue,
    query, orderByChild, limitToLast, endBefore
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
// 🔥 SETTINGS
// ============================================================
const PAGE_SIZE = 20;                       // ek baar me kitne transactions
const PROFILE_TTL = 10 * 60 * 1000;         // profile cache 10 min
const SUMMARY_TTL = 10 * 60 * 1000;         // totals cache 10 min

// ============================================================
// 🔥 STATE
// ============================================================
let currentFilter = 'all';
let currentSearch = '';
let currentUid = null;
let unsubscribeListener = null;
let isInitialLoad = true;
let hasMore = true;
let loadingMore = false;
let shellBuilt = false;
let renderQueued = false;
let summaryData = null;
let summaryLoading = false;

const txMap = new Map();                    // id -> transaction
const nameCache = new Map();                // uid -> name
const nameFetching = new Set();
const failedNames = new Set();

const NAME_KEY = 'rnd_name_cache_v1';
try {
    const saved = JSON.parse(sessionStorage.getItem(NAME_KEY) || '{}');
    Object.entries(saved).forEach(([k, v]) => nameCache.set(k, v));
} catch (e) { /* ignore */ }

function persistNames() {
    try { sessionStorage.setItem(NAME_KEY, JSON.stringify(Object.fromEntries(nameCache))); } catch (e) { /* ignore */ }
}

// ============================================================
// 🔥 SMALL UTILITIES
// ============================================================
const $ = (id) => document.getElementById(id);

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function hasNum(v) {
    return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
}

function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
}

function validUid(uid) {
    return typeof uid === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(uid);
}

function statusOf(t) {
    return String(t.status || '').toLowerCase();
}

// ============================================================
// 🔥 TOAST SYSTEM
// ============================================================
function showToast(message, type = 'success') {
    const container = $('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger';

    const i = document.createElement('i');
    i.className = `bi ${icon}`;
    const span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = message;
    toast.appendChild(i);
    toast.appendChild(span);

    toast.style.cssText = `
        background: rgba(19,34,55,0.95);
        backdrop-filter: blur(10px);
        border: 1px solid ${type === 'success' ? 'rgba(46,204,113,0.3)' : 'rgba(239,68,68,0.3)'};
        border-radius: 12px;
        padding: 12px 20px;
        margin-bottom: 10px;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 0.9rem;
        transform: translateX(120%);
        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        min-width: 280px;
        max-width: 450px;
        z-index: 9999;
    `;
    container.appendChild(toast);

    requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });

    setTimeout(() => {
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => toast.remove(), 400);
    }, 5000);
}

// ============================================================
// 🔥 SIDEBAR CONTROLS
// ============================================================
const sidebarPanel = $('sidebarPanel');
const sidebarOverlay = $('sidebarOverlay');
const sidebarToggle = $('sidebarToggle');
const sidebarClose = $('sidebarClose');

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

$('logoutBtnSidebar')?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
        sessionStorage.clear();
        await signOut(auth);
    } catch (err) {
        console.warn('Logout error:', err);
    }
    window.location.href = 'login.html';
});

// ============================================================
// 🔥 FORMATTING HELPERS
// ============================================================
function formatDate(timestamp) {
    if (!timestamp) return 'N/A';
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function formatDateShort(timestamp) {
    if (!timestamp) return 'N/A';
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ============================================================
// 🔥 SMART PENDING DAYS PARSER
// ============================================================
function extractPendingDays(description) {
    if (!description) return null;
    const patterns = [
        /\((\d+)\s+days?\s+pending\)/i,
        /(\d+)\s+days?\s+pending/i,
        /pending\s+for\s+(\d+)\s+days?/i
    ];
    for (const p of patterns) {
        const m = description.match(p);
        if (m) return parseInt(m[1], 10);
    }
    return null;
}

function extractPackageName(description) {
    if (!description) return null;
    const match = description.match(/from\s+(.+?)(?:\s*\(|$)/i);
    if (match) return match[1].trim();
    const match2 = description.match(/^(.+?)\s+pending\s+release/i);
    if (match2) return match2[1].trim();
    return null;
}

// ============================================================
// 🔥 TYPE MAPS
// ============================================================
const NEGATIVE_TYPES = ['withdrawal', 'transfer_sent', 'admin_debit'];
const POSITIVE_TYPES = ['deposit', 'transfer_received', 'referral_commission', 'daily_release', 'pending_release', 'admin_credit', 'bonus', 'package_completed'];

function getTypeIcon(type) {
    const map = {
        deposit: 'bi-arrow-down-circle',
        withdrawal: 'bi-arrow-up-circle',
        package: 'bi-box-seam',
        transfer_sent: 'bi-arrow-up-right',
        transfer_received: 'bi-arrow-down-left',
        referral_commission: 'bi-people',
        daily_release: 'bi-clock-history',
        pending_release: 'bi-clock-history',
        admin_credit: 'bi-plus-circle',
        admin_debit: 'bi-dash-circle',
        bonus: 'bi-gift',
        package_completed: 'bi-check-circle'
    };
    return map[type] || 'bi-circle';
}

function getTypeClass(type) {
    const map = {
        deposit: 'deposit',
        withdrawal: 'withdraw',
        package: 'package',
        transfer_sent: 'transfer-sent',
        transfer_received: 'transfer-received',
        referral_commission: 'referral',
        daily_release: 'release',
        pending_release: 'release',
        admin_credit: 'admin',
        admin_debit: 'admin',
        bonus: 'bonus',
        package_completed: 'package'
    };
    return map[type] || 'deposit';
}

function getTypeLabel(type) {
    const map = {
        deposit: 'Deposit',
        withdrawal: 'Withdrawal',
        package: 'Package Purchase',
        transfer_sent: 'Transfer Sent',
        transfer_received: 'Transfer Received',
        referral_commission: 'Referral Commission',
        daily_release: 'Daily Release',
        pending_release: 'Pending Release',
        admin_credit: 'Admin Credit',
        admin_debit: 'Admin Debit',
        bonus: 'Bonus Credit',
        package_completed: 'Package Completed'
    };
    return map[type] || type || 'Transaction';
}

function getAmountClass(type) {
    if (NEGATIVE_TYPES.includes(type)) return 'negative';
    if (POSITIVE_TYPES.includes(type)) return 'positive';
    return 'neutral';
}

function getAmountSign(type) {
    if (NEGATIVE_TYPES.includes(type)) return '-';
    if (POSITIVE_TYPES.includes(type)) return '+';
    return '';
}

function getStatusClass(status) {
    if (!status) return 'approved';
    const s = String(status).toLowerCase();
    if (s === 'pending') return 'pending';
    if (['approved', 'active', 'completed', 'success'].includes(s)) return 'approved';
    if (s === 'rejected' || s === 'failed') return 'rejected';
    return 'approved';
}

function getStatusLabel(status) {
    if (!status) return 'Completed';
    const s = String(status).toLowerCase();
    const map = {
        pending: '⏳ Pending',
        approved: '✅ Approved',
        completed: '✅ Completed',
        active: '🟢 Active',
        rejected: '❌ Rejected',
        failed: '❌ Failed',
        success: '✅ Success'
    };
    return map[s] || String(status);
}

// ============================================================
// 🔥 USER NAMES - sirf zarurat wale users ka naam (poora users node NAHI)
// ============================================================
function getFromUid(t) { return t.fromUser || t.fromUserId || t.senderUid || t.fromUid || null; }
function getToUid(t) { return t.toUserId || t.receiverUid || t.toUid || null; }
function getReferredUid(t) { return t.referredUserId || t.referralUid || null; }

function displayName(uid, storedName) {
    if (storedName) return String(storedName);
    if (!uid) return 'Unknown';
    if (nameCache.has(uid)) return nameCache.get(uid);
    if (failedNames.has(uid)) return 'User';
    return 'Loading...';
}

async function fetchUserName(uid) {
    const fields = ['name', 'username', 'referralCode', 'fullName'];
    for (const f of fields) {
        const snap = await get(ref(db, `users/${uid}/${f}`));
        if (snap.exists() && snap.val()) return String(snap.val());
    }
    return 'User';
}

async function resolveMissingNames() {
    const need = new Set();
    const add = (uid) => {
        if (validUid(uid) && !nameCache.has(uid) && !nameFetching.has(uid) && !failedNames.has(uid)) need.add(uid);
    };

    txMap.forEach((t) => {
        if (t.type === 'transfer_sent' && !t.toName) add(getToUid(t));
        else if (t.type === 'transfer_received' && !t.fromName) add(getFromUid(t));
        else if (t.type === 'referral_commission' && !t.referredName && !t.fromName) add(getReferredUid(t) || getFromUid(t));
    });

    if (need.size === 0) return;
    need.forEach((uid) => nameFetching.add(uid));

    await Promise.all([...need].map(async (uid) => {
        try {
            const name = await fetchUserName(uid);
            nameCache.set(uid, name);
        } catch (err) {
            failedNames.add(uid);
        } finally {
            nameFetching.delete(uid);
        }
    }));

    persistNames();
    scheduleRender();
}

// ============================================================
// 🔥 PROFILE (sidebar) - sirf chhote fields, cache ke saath
// ============================================================
async function loadProfile(uid) {
    const key = `rnd_profile_${uid}`;
    try {
        const cached = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (cached && Date.now() - cached.t < PROFILE_TTL) return cached.data;
    } catch (e) { /* ignore */ }

    const fields = ['name', 'username', 'referralCode', 'totalReferrals', 'directReferrals'];
    const snaps = await Promise.all(fields.map((f) => get(ref(db, `users/${uid}/${f}`))));
    const data = {};
    fields.forEach((f, i) => { data[f] = snaps[i].exists() ? snaps[i].val() : null; });

    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), data })); } catch (e) { /* ignore */ }
    return data;
}

// ============================================================
// 🔥 TRANSACTIONS - SORTED LIST FROM MAP
// ============================================================
function sortedList() {
    return [...txMap.values()].sort((a, b) => {
        const diff = num(b.timestamp) - num(a.timestamp);
        if (diff !== 0) return diff;
        return String(b.id).localeCompare(String(a.id));
    });
}

function ingestSnapshot(snap) {
    let count = 0;
    snap.forEach((child) => {
        const v = child.val();
        if (v && typeof v === 'object') {
            txMap.set(child.key, { id: child.key, ...v });
            count++;
        }
    });
    return count;
}

function txQuery(uid, extra = []) {
    return query(
        ref(db, `users/${uid}/transactions`),
        orderByChild('timestamp'),
        ...extra,
        limitToLast(PAGE_SIZE)
    );
}

// ============================================================
// 🔥 REAL-TIME LISTENER - sirf latest PAGE_SIZE transactions
// ============================================================
function setupRealTimeListener(uid) {
    if (unsubscribeListener) {
        unsubscribeListener();
        unsubscribeListener = null;
    }

    currentUid = uid;
    txMap.clear();
    hasMore = true;
    isInitialLoad = true;

    unsubscribeListener = onValue(txQuery(uid), (snapshot) => {
        const count = ingestSnapshot(snapshot);

        if (isInitialLoad) {
            hasMore = count >= PAGE_SIZE;
            isInitialLoad = false;
            showToast(`✅ ${txMap.size} recent transactions loaded`, 'success');
        }

        scheduleRender();
        resolveMissingNames();
    }, (error) => {
        console.error('Listener error:', error);
        showToast('Error loading transactions: ' + error.message, 'error');
        const list = $('txList');
        if (list && txMap.size === 0) {
            list.innerHTML = `<div class="no-transactions"><i class="bi bi-exclamation-triangle"></i><p>Could not load transactions.</p></div>`;
        }
    });
}

// ============================================================
// 🔥 LOAD OLDER (pagination) - sirf agle PAGE_SIZE records
// ============================================================
async function loadMore() {
    if (loadingMore || !hasMore || !currentUid) return;
    loadingMore = true;
    renderLoadMore();

    try {
        const list = sortedList();
        const oldest = list[list.length - 1];
        if (!oldest) {
            hasMore = false;
            return;
        }

        const q = txQuery(currentUid, [endBefore(hasNum(oldest.timestamp) ? Number(oldest.timestamp) : null, oldest.id)]);
        const snap = await get(q);
        const count = ingestSnapshot(snap);
        if (count < PAGE_SIZE) hasMore = false;
    } catch (err) {
        console.error('Load more error:', err);
        showToast('Could not load older transactions: ' + err.message, 'error');
    } finally {
        loadingMore = false;
        scheduleRender();
        resolveMissingNames();
    }
}

// ============================================================
// 🔥 SUMMARY TOTALS - on demand (poori history sirf button dabane par)
// ============================================================
function computeSummary(list) {
    const sumBy = (fn) => list.filter(fn).reduce((s, t) => s + num(t.amount), 0);
    return {
        totalDeposits: sumBy((t) => t.type === 'deposit' && !['pending', 'rejected', 'failed'].includes(statusOf(t))),
        totalWithdrawals: sumBy((t) => t.type === 'withdrawal' && ['approved', 'completed', 'success'].includes(statusOf(t))),
        totalReferralIncome: sumBy((t) => t.type === 'referral_commission'),
        totalRelease: sumBy((t) => t.type === 'daily_release' || t.type === 'pending_release'),
        totalBonus: sumBy((t) => t.type === 'bonus'),
        count: list.length
    };
}

function loadSummaryFromCache(uid) {
    try {
        const cached = JSON.parse(sessionStorage.getItem(`rnd_tx_summary_${uid}`) || 'null');
        if (cached && Date.now() - cached.t < SUMMARY_TTL) {
            summaryData = cached.data;
        }
    } catch (e) { /* ignore */ }
}

async function loadSummary() {
    if (summaryLoading || !currentUid) return;
    summaryLoading = true;
    renderSummary();

    try {
        const snap = await get(ref(db, `users/${currentUid}/transactions`));
        const list = [];
        snap.forEach((c) => {
            const v = c.val();
            if (v && typeof v === 'object') list.push(v);
        });
        summaryData = computeSummary(list);
        try {
            sessionStorage.setItem(`rnd_tx_summary_${currentUid}`, JSON.stringify({ t: Date.now(), data: summaryData }));
        } catch (e) { /* ignore */ }
    } catch (err) {
        console.error('Summary error:', err);
        showToast('Could not calculate totals: ' + err.message, 'error');
    } finally {
        summaryLoading = false;
        renderSummary();
    }
}

function renderSummary() {
    const wrap = $('summaryWrap');
    if (!wrap) return;

    if (!summaryData) {
        wrap.innerHTML = `
            <div class="summary-stats">
                <div class="stat-box" style="grid-column:1/-1;text-align:center;">
                    <div class="label mb-2">📊 Totals — Deposits, Withdrawals, Referral, Release, Bonus</div>
                    <button class="filter-btn" id="loadSummaryBtn" ${summaryLoading ? 'disabled' : ''}>
                        <i class="bi bi-calculator"></i> ${summaryLoading ? 'Calculating...' : 'Show Totals'}
                    </button>
                    <div class="label mt-2" style="font-size:0.7rem;opacity:0.7;">Poori history ek baar load hogi</div>
                </div>
            </div>`;
        return;
    }

    const s = summaryData;
    wrap.innerHTML = `
        <div class="summary-stats">
            <div class="stat-box">
                <div class="num green">${s.totalDeposits.toFixed(2)}</div>
                <div class="label">💰 Total Deposits</div>
            </div>
            <div class="stat-box">
                <div class="num gold">${s.totalWithdrawals.toFixed(2)}</div>
                <div class="label">🏦 Total Withdrawn</div>
            </div>
            <div class="stat-box">
                <div class="num purple">${s.totalReferralIncome.toFixed(2)}</div>
                <div class="label">👥 Referral Income</div>
            </div>
            <div class="stat-box">
                <div class="num" style="color:#34d399;">${s.totalRelease.toFixed(2)}</div>
                <div class="label">📈 Total Release (Daily + Pending)</div>
            </div>
            <div class="stat-box">
                <div class="num pink">${s.totalBonus.toFixed(2)}</div>
                <div class="label">🎁 Bonus Received</div>
            </div>
            <div class="stat-box">
                <div class="num blue">${s.count}</div>
                <div class="label">📋 Total Transactions</div>
            </div>
        </div>
        <div class="text-end mt-2">
            <button class="filter-btn" id="loadSummaryBtn" ${summaryLoading ? 'disabled' : ''}>
                <i class="bi bi-arrow-clockwise"></i> ${summaryLoading ? 'Refreshing...' : 'Refresh Totals'}
            </button>
        </div>`;
}

// ============================================================
// 🔥 FILTER + SEARCH
// ============================================================
function matchesFilter(t, filter) {
    switch (filter) {
        case 'all': return true;
        case 'deposit': return t.type === 'deposit';
        case 'withdrawal': return t.type === 'withdrawal';
        case 'package': return t.type === 'package' || t.type === 'package_completed';
        case 'transfer': return t.type === 'transfer_sent' || t.type === 'transfer_received';
        case 'referral': return t.type === 'referral_commission';
        case 'release': return t.type === 'daily_release' || t.type === 'pending_release';
        case 'bonus': return t.type === 'bonus';
        case 'admin': return t.type === 'admin_credit' || t.type === 'admin_debit';
        default: return true;
    }
}

function matchesSearch(t, q) {
    const fromUid = getFromUid(t);
    const toUid = getToUid(t);
    const refUid = getReferredUid(t);

    const searchable = [
        t.type, t.description, t.planName, t.packageName,
        t.fromName || nameCache.get(fromUid),
        t.toName || nameCache.get(toUid),
        t.referredName || nameCache.get(refUid),
        t.status, t.currency, t.txHash, t.walletAddress,
        t.remark, t.reason, t.bonusName, t.id,
        t.fromUser, t.fromUid, t.toUid
    ].filter(Boolean).join(' ').toLowerCase();

    const amountStr = String(t.amount ?? '');
    const dateStr = t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-IN') : '';

    return searchable.includes(q) || amountStr.includes(q) || dateStr.includes(q);
}

// ============================================================
// 🔥 RENDER ONE ROW
// ============================================================
function renderRow(t) {
    const icon = getTypeIcon(t.type);
    const iconClass = getTypeClass(t.type);
    const label = getTypeLabel(t.type);
    const amountClass = getAmountClass(t.type);
    const sign = getAmountSign(t.type);
    const statusClass = getStatusClass(t.status);
    const statusLabel = getStatusLabel(t.status);

    let extraHtml = '';
    let description = t.description ? String(t.description) : '';
    const packageName = t.packageName || t.planName || '';

    if (t.type === 'pending_release') {
        let pendingDays = hasNum(t.pendingDays) && Number(t.pendingDays) > 0 ? Number(t.pendingDays)
            : (hasNum(t.days) && Number(t.days) > 0 ? Number(t.days) : null);
        if (pendingDays === null) pendingDays = extractPendingDays(description);

        const pkg = packageName || extractPackageName(description) || 'Package';
        const daysHtml = pendingDays !== null && pendingDays > 0
            ? `| Pending: ${pendingDays} day${pendingDays > 1 ? 's' : ''}` : '';

        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-clock-history"></i>
                ${esc(pkg)}
                ${daysHtml}
                ${hasNum(t.totalReleased) ? `| Released: ${Number(t.totalReleased).toFixed(2)} RND` : ''}
            </div>`;

        if (!description || description === 'Pending Release') {
            description = pendingDays !== null && pendingDays > 0
                ? `Pending release for ${pendingDays} day${pendingDays > 1 ? 's' : ''}`
                : 'Pending release';
        }
    }
    else if (t.type === 'daily_release') {
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-clock-history"></i>
                ${esc(packageName || 'Package')}
                ${hasNum(t.remainingRND) ? `| Remaining: ${Number(t.remainingRND).toFixed(2)} RND` : ''}
                ${hasNum(t.totalReleased) ? `| Total Released: ${Number(t.totalReleased).toFixed(2)} RND` : ''}
            </div>`;
        if (!description) description = 'Daily release from ' + (packageName || 'package');
    }
    else if (t.type === 'package' || t.type === 'package_completed') {
        const pkgName = t.planName || t.packageName || 'Package';
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-box-seam"></i>
                ${esc(pkgName)}
                ${hasNum(t.totalRND) && Number(t.totalRND) ? `| Total: ${Number(t.totalRND).toFixed(2)} RND` : ''}
                ${hasNum(t.dailyRelease) && Number(t.dailyRelease) ? `| Daily: ${Number(t.dailyRelease).toFixed(4)} RND` : ''}
                ${t.completedDate ? `| Completed: ${esc(formatDateShort(t.completedDate))}` : ''}
            </div>`;
        if (!description) description = `${pkgName} purchase`;
    }
    else if (t.type === 'deposit') {
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-wallet2"></i> ${t.walletAddress ? esc(String(t.walletAddress).substring(0, 16)) + '...' : 'Wallet'}
                ${t.txHash ? `| TX: <span style="font-family:monospace;font-size:0.6rem;color:#60a5fa;">${esc(String(t.txHash).substring(0, 14))}...</span>` : ''}
            </div>`;
        if (!description) description = 'Deposit via ' + (t.currency || 'USDT');
    }
    else if (t.type === 'withdrawal') {
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-wallet2"></i> ${t.walletAddress ? esc(String(t.walletAddress).substring(0, 16)) + '...' : 'External Wallet'}
                ${t.network ? `| Network: ${esc(t.network)}` : ''}
                ${t.txHash ? `| TX: <span style="font-family:monospace;font-size:0.6rem;color:#60a5fa;">${esc(String(t.txHash).substring(0, 14))}...</span>` : ''}
            </div>`;
        if (!description) description = 'Withdrawal request';
    }
    else if (t.type === 'transfer_sent' || t.type === 'transfer_received') {
        const sent = t.type === 'transfer_sent';
        const otherName = sent ? displayName(getToUid(t), t.toName) : displayName(getFromUid(t), t.fromName);
        const action = sent ? 'To' : 'From';
        const emoji = sent ? '↗️' : '↙️';
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-person"></i> ${action}: <span class="name">${esc(otherName)}</span>
                ${sent ? ' (sent)' : ' (received)'}
            </div>`;
        if (!description) description = `${emoji} ${action} ${otherName}`;
    }
    else if (t.type === 'referral_commission') {
        const refName = t.referredName || t.fromName || displayName(getReferredUid(t) || getFromUid(t), null);
        const level = t.level || t.referralLevel || '';
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-people"></i>
                Level ${level ? esc(level) + ' | ' : ''}
                From: <span class="name">${esc(refName)}</span>
                ${t.packageName ? `| Package: ${esc(t.packageName)}` : ''}
            </div>`;
        if (!description) description = `Level ${level || 1} referral commission`;
    }
    else if (t.type === 'bonus') {
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-gift"></i>
                ${esc(t.bonusName || 'Bonus')}
                ${t.description && t.description !== description ? `| ${esc(t.description)}` : ''}
            </div>`;
        if (!description) description = t.bonusName || 'Bonus credit';
    }
    else if (t.type === 'admin_credit' || t.type === 'admin_debit') {
        const action = t.type === 'admin_credit' ? 'Credit' : 'Debit';
        extraHtml = `
            <div class="sub-detail">
                <i class="bi bi-shield"></i>
                ${action} ${esc(t.reason || '')}
                ${t.remark ? `| Remark: ${esc(t.remark)}` : ''}
            </div>`;
        if (!description) description = `Admin ${action}`;
    }

    const refNum = t.id ? String(t.id).substring(0, 8) : 'N/A';
    const currency = t.currency || 'USDT';
    const amountDisplay = num(t.amount).toFixed(currency === 'RND' ? 4 : 2);

    return `
        <div class="transaction-item">
            <div class="d-flex align-items-center gap-3" style="flex:1;min-width:0;">
                <div class="type-icon ${iconClass}">
                    <i class="bi ${icon}"></i>
                </div>
                <div class="info">
                    <h6>${esc(label)}</h6>
                    <div class="sub-detail">${esc(description)}</div>
                    ${extraHtml}
                    <div class="from-to">
                        <i class="bi bi-clock"></i> ${esc(formatDate(t.timestamp))}
                        ${t.packageId ? ` | ID: ${esc(String(t.packageId).substring(0, 10))}...` : ''}
                    </div>
                </div>
            </div>
            <div class="amount-section">
                <div class="amount ${amountClass}">
                    ${sign}${amountDisplay} ${esc(currency)}
                </div>
                <div class="status ${statusClass}">${esc(statusLabel)}</div>
                <div class="date">#${esc(refNum)}</div>
            </div>
        </div>`;
}

// ============================================================
// 🔥 PAGE SHELL (ek baar banta hai - search box ka focus nahi jaata)
// ============================================================
function buildShell() {
    const container = $('transactionsContent');
    if (!container) return;

    const filters = [
        ['all', 'bi-list', 'All'],
        ['deposit', 'bi-arrow-down-circle', 'Deposits'],
        ['withdrawal', 'bi-arrow-up-circle', 'Withdrawals'],
        ['package', 'bi-box-seam', 'Packages'],
        ['release', 'bi-clock-history', 'Releases'],
        ['referral', 'bi-people', 'Referrals'],
        ['transfer', 'bi-arrow-left-right', 'Transfers'],
        ['admin', 'bi-shield', 'Admin'],
        ['bonus', 'bi-gift', 'Bonus']
    ];

    container.innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-3">
                    <h4 class="fw-bold"><i class="bi bi-receipt text-success me-2"></i>Transaction History</h4>
                    <div class="d-flex flex-wrap align-items-center gap-3">
                        <div class="real-time-badge">
                            <span class="dot"></span> Real-time
                        </div>
                        <span class="text-muted small" id="txCount">0 transactions</span>
                        <input type="text" class="search-box" id="searchInput" placeholder="Search transactions..." autocomplete="off" />
                    </div>
                </div>
                <hr class="border-secondary">
            </div>

            <div class="col-12" id="summaryWrap"></div>

            <div class="col-12">
                <div class="filter-buttons" id="filterButtons">
                    ${filters.map(([key, icon, text]) => `
                        <button class="filter-btn ${key === currentFilter ? 'active' : ''}" data-filter="${key}">
                            <i class="bi ${icon}"></i> ${text}
                        </button>`).join('')}
                </div>
            </div>

            <div class="col-12">
                <div class="card-glass" id="txList">
                    <div class="no-transactions"><i class="bi bi-hourglass-split"></i><p>Loading transactions...</p></div>
                </div>
                <div class="text-center mt-3" id="loadMoreWrap"></div>
            </div>

            <div class="col-12 text-center">
                <button class="btn-print" id="printBtn" style="
                    background: linear-gradient(135deg, #2ecc71, #27ae60);
                    border: none;
                    color: #fff;
                    font-weight: 600;
                    padding: 12px 28px;
                    border-radius: 60px;
                    transition: all 0.3s ease;
                    font-size: 0.9rem;
                    display: inline-flex;
                    align-items: center;
                    gap: 10px;
                    cursor: pointer;
                ">
                    <i class="bi bi-printer"></i> Print / PDF
                </button>
            </div>
        </div>
    `;

    // Events (delegation - ek hi baar attach hote hain)
    $('filterButtons').addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        currentFilter = btn.dataset.filter || 'all';
        scheduleRender();
    });

    let debounceTimer;
    $('searchInput').addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const value = e.target.value;
        debounceTimer = setTimeout(() => {
            currentSearch = value;
            scheduleRender();
        }, 250);
    });

    $('loadMoreWrap').addEventListener('click', (e) => {
        if (e.target.closest('#loadMoreBtn')) loadMore();
    });

    $('summaryWrap').addEventListener('click', (e) => {
        if (e.target.closest('#loadSummaryBtn')) loadSummary();
    });

    $('printBtn').addEventListener('click', () => window.print());

    shellBuilt = true;
    renderSummary();
}

// ============================================================
// 🔥 RENDER (sirf list, buttons aur count update hote hain)
// ============================================================
function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        renderTransactions();
    });
}

function renderLoadMore() {
    const wrap = $('loadMoreWrap');
    if (!wrap) return;

    if (hasMore) {
        wrap.innerHTML = `
            <button class="filter-btn" id="loadMoreBtn" ${loadingMore ? 'disabled' : ''}>
                <i class="bi bi-arrow-down-circle"></i> ${loadingMore ? 'Loading...' : 'Load older transactions'}
            </button>`;
    } else {
        wrap.innerHTML = txMap.size > 0
            ? `<p class="text-muted small mb-0">✅ All transactions loaded</p>`
            : '';
    }
}

function renderTransactions() {
    if (!shellBuilt) return;

    const all = sortedList();
    let filtered = all.filter((t) => matchesFilter(t, currentFilter));

    const q = (currentSearch || '').toLowerCase().trim();
    if (q) filtered = filtered.filter((t) => matchesSearch(t, q));

    // filter buttons active state
    document.querySelectorAll('#filterButtons .filter-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.filter === currentFilter);
    });

    // count
    setText('txCount', `${all.length}${hasMore ? '+' : ''} transactions`);

    // list
    const list = $('txList');
    if (!list) return;

    if (filtered.length === 0) {
        const filterText = currentFilter === 'all' ? '' : currentFilter + ' ';
        const hint = hasMore
            ? `<p class="text-muted small">Latest ${all.length} transactions me nahi mila. "Load older transactions" dabakar purane transactions me dekhein.</p>`
            : `<p class="text-muted small">${all.length} total transactions available</p>`;
        list.innerHTML = `
            <div class="no-transactions">
                <i class="bi bi-inbox"></i>
                <p>No ${esc(filterText)}transactions found.</p>
                ${hint}
            </div>`;
    } else {
        list.innerHTML = filtered.map(renderRow).join('');
    }

    renderLoadMore();
}

// ============================================================
// 🔥 MAIN - AUTH STATE
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    try {
        const profile = await loadProfile(user.uid);

        const name = profile.name || profile.username || 'User';
        const username = String(profile.username || profile.referralCode || 'USER');

        setText('sidebarName', name);
        setText('sidebarUserId', 'ID: ' + username.substring(0, 20) + (username.length > 20 ? '...' : ''));
        setText('sidebarAvatar', String(name).charAt(0).toUpperCase());

        const badge = $('referralBadge');
        if (badge) badge.textContent = profile.totalReferrals || profile.directReferrals || 0;

        currentUid = user.uid;
        loadSummaryFromCache(user.uid);
        buildShell();
        setupRealTimeListener(user.uid);

    } catch (error) {
        console.error('Error loading page:', error);
        const content = $('transactionsContent');
        if (content) {
            content.innerHTML = `
                <div class="text-center py-5">
                    <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                    <h4>Error Loading Page</h4>
                    <p class="text-muted">${esc(error.message || 'Please check your internet connection.')}</p>
                    <button class="btn btn-primary-custom mt-3" id="reloadBtn">Refresh</button>
                </div>`;
            $('reloadBtn')?.addEventListener('click', () => location.reload());
        }
        showToast('Error loading transactions: ' + (error.message || 'Unknown error'), 'error');
    }
});

// ============================================================
// 🔥 CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (unsubscribeListener) {
        unsubscribeListener();
        unsubscribeListener = null;
    }
});

console.log('✅ Transactions page loaded (OPTIMIZED - paginated, low bandwidth)');
