// ============================================================
// RND STAKING - REFERRALS.JS (v6.1 - Low Bandwidth Edition)
// ============================================================
// 📌 RULES:
// 1. Clean UI - koi warning message user ko nahi
// 2. Name, Email, User ID, Commission sab dikhta hai
// 3. READ ONLY - database me koi write nahi
// 4. Styles referrals.css me hain (JS me inline CSS nahi)
// 5. Sirf zaroorat ka data download hota hai:
//    - Summary: sirf chhote child nodes (teamStructure, wallet, earnings)
//    - Members: indexed query (referredBy) - poora /users kabhi nahi
//    - Level 2-5: sirf tab load hote hain jab user tab kholta hai
//    - Commission history: sirf last 20, "Load More" par agle 20
//    - Cache: sessionStorage me 5 minute (page switch par dubara download nahi)
// ============================================================
//
// ⚠️ Firebase Rules me ye zaroor ho (users ke andar):
//    ".indexOn": ["referredBy"]
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
    getDatabase, ref, get, onValue, query,
    orderByChild, orderByKey, equalTo, limitToLast, endBefore
} from "firebase/database";

// ============================================================
// CONFIG
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

const PAGE_SIZE = 20;            // commission history per page
const MEMBERS_PAGE = 25;         // members rows per "Load More"
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const FETCH_CONCURRENCY = 8;     // parallel queries for deeper levels
const MASK_DOWNLINE_EMAIL = true; // Level 2-5 ki email partially hidden (privacy)
const LEVELS = [1, 2, 3, 4, 5];
const RATES = { 1: 0.08, 2: 0.04, 3: 0.02, 4: 0.01, 5: 0.01 };
const COLORS = { 1: '#fbbf24', 2: '#60a5fa', 3: '#a78bfa', 4: '#f472b6', 5: '#fb923c' };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Sirf ye chhote fields real-time sune jaate hain (poora user doc nahi)
const SUMMARY_FIELDS = [
    'referralCode', 'name', 'username', 'teamStructure', 'referralWallet',
    'level1Earnings', 'level2Earnings', 'level3Earnings', 'level4Earnings', 'level5Earnings'
];

// ============================================================
// STATE
// ============================================================
let currentUserId = null;
let unsubscribers = [];
let summary = {};
let received = new Set();
let shellBuilt = false;
let renderTimer = null;
let lastEarningsSig = null;
let activeLevel = 1;
let gen = 0; // refresh hone par purane async results ignore karne ke liye

const levels = {};
LEVELS.forEach(l => { levels[l] = { status: 'idle', data: [], visible: MEMBERS_PAGE, promise: null }; });
const history = { items: [], oldestKey: null, hasMore: false, loading: false, loaded: false };

// ============================================================
// UTILITIES
// ============================================================
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => num(v).toFixed(2);

function showToast(message, type = 'success') {
    const container = $('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = document.createElement('i');
    icon.className = 'bi ' + (type === 'success'
        ? 'bi-check-circle-fill text-success'
        : 'bi-exclamation-triangle-fill text-danger');
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;
    toast.append(icon, msg);
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function formatDate(ts) {
    if (!ts) return 'N/A';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function maskEmail(email) {
    if (!email || !email.includes('@')) return 'N/A';
    const [user, domain] = email.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
}

function getLevelCommission(stake, level) {
    return num(stake) * (RATES[level] || 0);
}

// ---------- sessionStorage cache ----------
const cacheKey = (level) => `rnd_ref_${currentUserId}_L${level}`;

function readCache(level) {
    try {
        const raw = sessionStorage.getItem(cacheKey(level));
        if (!raw) return null;
        const { t, data } = JSON.parse(raw);
        if (Date.now() - t > CACHE_TTL || !Array.isArray(data)) return null;
        return data;
    } catch { return null; }
}

function writeCache(level, data) {
    try { sessionStorage.setItem(cacheKey(level), JSON.stringify({ t: Date.now(), data })); } catch { /* storage full - ignore */ }
}

function clearCache() {
    try { LEVELS.forEach(l => sessionStorage.removeItem(cacheKey(l))); } catch { /* ignore */ }
}

// ---------- limited-concurrency runner ----------
async function runPool(items, limit, worker) {
    const out = new Array(items.length);
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await worker(items[idx]);
        }
    });
    await Promise.all(runners);
    return out;
}

// ============================================================
// SIDEBAR
// ============================================================
function setupSidebar() {
    const panel = $('sidebarPanel');
    const overlay = $('sidebarOverlay');
    const toggleBtn = $('sidebarToggle');
    const open = () => {
        panel?.classList.add('open');
        overlay?.classList.add('active');
        panel?.setAttribute('aria-hidden', 'false');
        toggleBtn?.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
        $('sidebarClose')?.focus();
    };
    const close = () => {
        panel?.classList.remove('open');
        overlay?.classList.remove('active');
        panel?.setAttribute('aria-hidden', 'true');
        toggleBtn?.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    };
    $('sidebarToggle')?.addEventListener('click', open);
    $('sidebarClose')?.addEventListener('click', close);
    overlay?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    $('logoutBtnSidebar')?.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
            cleanup();
            clearCache();
            await signOut(auth);
            window.location.href = 'login.html';
        } catch {
            showToast('Error logging out', 'error');
        }
    });
}

// ============================================================
// MEMBERS - indexed queries (poora /users kabhi download nahi)
// ============================================================
async function fetchDirectReferrals(code) {
    // Sirf wahi users jinka referredBy == code
    const snap = await get(query(ref(db, 'users'), orderByChild('referredBy'), equalTo(code)));
    const out = [];
    snap.forEach(child => {
        const v = child.val() || {};
        out.push({
            uid: child.key,
            name: v.name || '',
            email: v.email || '',
            totalStake: num(v.totalStake),
            createdAt: v.createdAt || null,
            referralCode: v.referralCode || ''
        });
    });
    return out;
}

function loadLevelData(level) {
    const st = levels[level];
    if (st.status === 'ready') return Promise.resolve(st.data);
    if (st.promise) return st.promise;

    const myGen = gen;
    st.status = 'loading';

    st.promise = (async () => {
        try {
            const cached = readCache(level);
            if (cached) {
                if (myGen === gen) { st.data = cached; st.status = 'ready'; }
                return cached;
            }

            let codes;
            if (level === 1) {
                codes = summary.referralCode ? [summary.referralCode] : [];
            } else {
                const prev = await loadLevelData(level - 1);
                codes = [...new Set(prev.map(m => m.referralCode).filter(Boolean))];
            }

            // Loop / duplicate se bachne ke liye: upar ke levels + khud ko skip
            const seen = new Set([currentUserId]);
            for (let l = 1; l < level; l++) levels[l].data.forEach(m => seen.add(m.uid));

            const results = await runPool(codes, FETCH_CONCURRENCY, fetchDirectReferrals);
            const list = [];
            results.forEach(arr => arr.forEach(m => {
                if (!seen.has(m.uid)) { seen.add(m.uid); list.push(m); }
            }));
            list.sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));

            if (myGen === gen) {
                st.data = list;
                st.status = 'ready';
                writeCache(level, list);
            }
            return list;
        } catch (err) {
            console.error(`Level ${level} load error:`, err);
            if (myGen === gen) st.status = 'error';
            throw err;
        } finally {
            if (myGen === gen) st.promise = null;
        }
    })();

    return st.promise;
}

async function showLevel(level) {
    activeLevel = level;
    renderMembers();
    try {
        await loadLevelData(level);
    } catch { /* error state render me dikhega */ }
    renderMembers();
}

function refreshMembers() {
    gen++;
    clearCache();
    LEVELS.forEach(l => { levels[l] = { status: 'idle', data: [], visible: MEMBERS_PAGE, promise: null }; });
    showLevel(activeLevel);
}

// ============================================================
// COMMISSION HISTORY - sirf last N, "Load More" par agle N
// ============================================================
async function loadHistory(reset = false) {
    if (history.loading) return;
    history.loading = true;
    if (reset) {
        history.items = [];
        history.oldestKey = null;
        history.hasMore = false;
        history.loaded = false;
    }
    renderHistory();

    try {
        const base = ref(db, `users/${currentUserId}/commissionHistory`);
        const q = history.oldestKey !== null
            ? query(base, orderByKey(), endBefore(history.oldestKey), limitToLast(PAGE_SIZE))
            : query(base, orderByKey(), limitToLast(PAGE_SIZE));
        const snap = await get(q);

        const batch = [];
        snap.forEach(c => {
            const v = c.val();
            batch.push({ key: c.key, ...(v && typeof v === 'object' ? v : {}) });
        });

        if (batch.length) {
            history.oldestKey = batch[0].key;
            history.items.push(...batch.reverse()); // newest first
        }
        history.hasMore = batch.length === PAGE_SIZE;
        history.loaded = true;
    } catch (err) {
        console.error('History load error:', err);
        history.loaded = true;
    } finally {
        history.loading = false;
        renderHistory();
    }
}

// ============================================================
// RENDER - SHELL (ek baar) + SECTIONS (alag alag update)
// ============================================================
function buildShell() {
    $('referralContent').innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <h4 class="fw-bold"><i class="bi bi-people text-success me-2"></i>Referral Program</h4>
                <hr class="border-secondary">
            </div>
            <div class="col-12" id="refSummary"></div>
            <div class="col-12" id="refMembers"></div>
            <div class="col-12" id="refHistory"></div>
        </div>`;
    shellBuilt = true;
}

function getDerived() {
    const ts = summary.teamStructure || {};
    const counts = {}, earns = {};
    LEVELS.forEach(l => {
        counts[l] = num(ts[`level${l}`]);
        earns[l] = num(summary[`level${l}Earnings`]);
    });
    const totalReferrals = LEVELS.reduce((s, l) => s + counts[l], 0);
    const totalEarn = LEVELS.reduce((s, l) => s + earns[l], 0);
    const downline = totalReferrals - counts[1];
    const downlineEarn = totalEarn - earns[1];
    return { counts, earns, totalReferrals, totalEarn, downline, downlineEarn };
}

function renderSummary() {
    const d = getDerived();
    const code = summary.referralCode || '';
    const link = `${REGISTER_URL}?ref=${encodeURIComponent(code)}`;

    // Sidebar
    const name = summary.name || 'User';
    const username = String(summary.username || code || 'USER');
    if ($('sidebarName')) $('sidebarName').textContent = name;
    if ($('sidebarUserId')) $('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + (username.length > 20 ? '...' : '');
    if ($('sidebarAvatar')) $('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
    if ($('referralBadge')) $('referralBadge').textContent = d.counts[1];

    const earnBox = (l) => `
        <div class="col-md-2 col-6">
            <div class="earnings-box" style="border-color:${COLORS[l]}33;">
                <span class="label">👥 Level ${l}</span>
                <span class="value" style="font-size:1rem;color:${COLORS[l]};">${d.counts[l]}</span>
                <span class="label" style="font-size:0.65rem;color:${COLORS[l]};">$${money(d.earns[l])}</span>
            </div>
        </div>`;

    $('refSummary').innerHTML = `
        <div class="row g-4">
            <div class="col-12">
                <div class="stats-grid">
                    <div class="stat-item">
                        <div class="number">${d.totalReferrals}</div>
                        <div class="label">Total Referrals</div>
                        <div class="earnings">💰 $${money(d.totalEarn)} Earned</div>
                    </div>
                    <div class="stat-item">
                        <div class="number">${d.downline}</div>
                        <div class="label">Total Downline</div>
                        <div class="earnings">💰 $${money(d.downlineEarn)} Earned</div>
                    </div>
                </div>
            </div>

            <div class="col-md-6">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-link-45deg"></i>Your Referral Link</div>
                    <div class="referral-box">
                        <code>${esc(link)}</code>
                        <button class="copy-btn" data-copy="${esc(link)}"><i class="bi bi-clipboard me-1"></i>Copy</button>
                    </div>
                    <div class="mt-2">
                        <small class="text-muted"><i class="bi bi-info-circle me-1"></i> Referral Code:
                            <strong style="color:#2ecc71;">${esc(code)}</strong></small>
                        <button class="ref-icon-btn ms-2" data-copy="${esc(code)}" style="padding:2px 8px;font-size:.7rem;">Copy code</button>
                    </div>
                    <div class="mt-2">
                        <small class="text-muted"><i class="bi bi-wallet2 me-1"></i> Referral Wallet:
                            <strong style="color:#fbbf24;">${money(summary.referralWallet)} USDT</strong></small>
                    </div>
                </div>
            </div>

            <div class="col-md-6">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-diagram-3"></i>Commission Structure</div>
                    <div class="row g-2">
                        ${LEVELS.map(l => `<div class="col-6"><small>Level ${l} (${RATES[l] * 100}%)</small></div>`).join('')}
                        <div class="col-6"><strong class="text-success">Total 16%</strong></div>
                    </div>
                    <div class="mt-3 pt-2 border-top border-secondary">
                        <div class="d-flex justify-content-between">
                            <span class="text-muted">Total Referral Earnings</span>
                            <span class="text-success fw-bold">$${money(d.totalEarn)}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="col-12">
                <div class="card-glass">
                    <div class="card-title"><i class="bi bi-cash-stack text-success me-2"></i>5 Level Referral Earnings</div>
                    <div class="row g-3">
                        ${LEVELS.map(earnBox).join('')}
                        <div class="col-md-2 col-6">
                            <div class="earnings-box" style="border-color:rgba(46,204,113,0.3);background:rgba(46,204,113,0.05);">
                                <span class="label">🏆 Total</span>
                                <span class="value" style="font-size:1.2rem;color:#2ecc71;">$${money(d.totalEarn)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
}

function renderMembers() {
    const host = $('refMembers');
    if (!host) return;
    const d = getDerived();
    const st = levels[activeLevel];
    const color = COLORS[activeLevel];

    const tabs = LEVELS.map(l => `
        <button class="lvl-tab ${l === activeLevel ? 'active' : ''}" data-level="${l}">
            Level ${l}<span class="cnt">(${d.counts[l]})</span>
        </button>`).join('');

    let body;
    if (st.status === 'loading' || st.status === 'idle') {
        body = `<div class="py-2"><div class="skel"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div>`;
    } else if (st.status === 'error') {
        body = `<div class="ref-center">
                    <i class="bi bi-cloud-slash fs-2 d-block mb-2"></i>
                    <p>Unable to load members right now.</p>
                    <button class="ref-icon-btn" data-action="retry">Try Again</button>
                </div>`;
    } else if (st.data.length === 0) {
        body = `<div class="ref-center">
                    <i class="bi bi-people fs-1 d-block mb-2"></i>
                    <p>${activeLevel === 1 ? 'No referrals yet. Share your referral link to earn!' : `No Level ${activeLevel} members yet.`}</p>
                </div>`;
    } else {
        const shown = st.data.slice(0, st.visible);
        const remaining = st.data.length - shown.length;
        const maskEmailNow = MASK_DOWNLINE_EMAIL && activeLevel > 1;
        body = `
            <div class="level-members-table">
                <table class="table table-custom">
                    <thead><tr>
                        <th>#</th><th>Name</th><th>Email</th><th>User ID</th><th>Stake</th><th>Commission</th><th>Joined</th>
                    </tr></thead>
                    <tbody>
                        ${shown.map((r, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td>${esc(r.name || 'N/A')}</td>
                                <td>${esc(maskEmailNow ? maskEmail(r.email) : (r.email || 'N/A'))}</td>
                                <td style="font-size:0.7rem;color:#a0b8d0;" title="${esc(r.uid)}">${esc(r.uid.substring(0, 12))}...</td>
                                <td>$${money(r.totalStake)}</td>
                                <td style="color:${color};">$${money(getLevelCommission(r.totalStake, activeLevel))}</td>
                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            ${remaining > 0 ? `
                <div class="text-center mt-3">
                    <button class="load-more-btn" data-action="more-members">
                        <i class="bi bi-plus-circle me-1"></i> Load More (${remaining} remaining)
                    </button>
                </div>` : ''}`;
    }

    host.innerHTML = `
        <div class="card-glass">
            <div class="ref-toolbar">
                <div class="card-title mb-0"><i class="bi bi-list-ul text-success me-2"></i>Your Team
                    <span class="level-badge">${RATES[activeLevel] * 100}%</span></div>
                <button class="ref-icon-btn" data-action="refresh" ${st.status === 'loading' ? 'disabled' : ''}>
                    <i class="bi bi-arrow-clockwise me-1"></i>Refresh
                </button>
            </div>
            <div class="lvl-tabs" role="tablist">${tabs}</div>
            ${body}
        </div>`;
}

function renderHistory() {
    const host = $('refHistory');
    if (!host) return;

    let body;
    if (!history.loaded && history.loading) {
        body = `<div class="py-2"><div class="skel"></div><div class="skel"></div><div class="skel" style="width:60%"></div></div>`;
    } else if (history.items.length === 0) {
        body = `<div class="text-center text-muted py-4">
                    <i class="bi bi-inbox fs-1 d-block mb-2"></i><p>No commission history yet.</p>
                </div>`;
    } else {
        body = `
            <div class="history-scroll">
                ${history.items.map(item => `
                    <div class="commission-history-item">
                        <div>
                            <span class="level-tag">Level ${esc(item.level || 1)}</span>
                            <span class="user">${esc(item.fromUser || 'Unknown')}</span>
                            ${item.packageId ? `<span class="text-muted" style="font-size:0.6rem;">(${esc(String(item.packageId).substring(0, 8))})</span>` : ''}
                        </div>
                        <div>
                            <span class="amount">+$${money(item.amount)}</span>
                            <span class="text-muted" style="font-size:0.6rem;">(${esc(num(item.percent))}%)</span>
                            <div class="date">${formatDate(item.date || item.timestamp)}</div>
                        </div>
                    </div>`).join('')}
            </div>
            ${history.hasMore ? `
                <div class="text-center mt-3">
                    <button class="load-more-btn" data-action="more-history" ${history.loading ? 'disabled' : ''}>
                        <i class="bi bi-plus-circle me-1"></i> ${history.loading ? 'Loading...' : 'Load More'}
                    </button>
                </div>` : ''}`;
    }

    host.innerHTML = `
        <div class="card-glass">
            <div class="card-title"><i class="bi bi-clock-history text-success me-2"></i>Commission History</div>
            ${body}
        </div>`;
}

// ============================================================
// SUMMARY LISTENERS (chhote nodes, real-time)
// ============================================================
function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(onSummaryChanged, 120); // multiple field updates = ek render
}

function onSummaryChanged() {
    if (received.size < SUMMARY_FIELDS.length) return; // pehle sab fields aane do

    if (!summary.referralCode && !summary.name) {
        $('referralContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-warning fs-1 d-block mb-3"></i>
                <h4>Profile Not Found</h4>
                <p class="text-muted">Please complete your profile first.</p>
                <a href="dashboard.html" class="btn btn-primary-custom mt-3">Go to Dashboard</a>
            </div>`;
        shellBuilt = false;
        return;
    }

    const firstTime = !shellBuilt;
    if (firstTime) buildShell();
    renderSummary();
    renderMembers();

    if (firstTime) {
        renderHistory();
        loadHistory(true);
        showLevel(1);
    }

    // Nayi commission aayi? to hi history ka pehla page dubara lo
    const sig = LEVELS.map(l => num(summary[`level${l}Earnings`])).join('|');
    if (lastEarningsSig !== null && sig !== lastEarningsSig) loadHistory(true);
    lastEarningsSig = sig;
}

function startSummaryListeners(uid) {
    SUMMARY_FIELDS.forEach(field => {
        const off = onValue(ref(db, `users/${uid}/${field}`), (snap) => {
            summary[field] = snap.val();
            received.add(field);
            scheduleRender();
        }, (err) => {
            console.error(`Listener error (${field}):`, err);
            showLoadError();
        });
        unsubscribers.push(off);
    });
}

function showLoadError() {
    if (shellBuilt) return;
    $('referralContent').innerHTML = `
        <div class="text-center py-5">
            <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
            <h4>Unable to Load Referrals</h4>
            <p class="text-muted">Please try again later.</p>
            <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
        </div>`;
}

function showSkeleton() {
    $('referralContent').innerHTML = `
        <div class="card-glass">
            <div class="skel" style="width:40%;height:22px"></div>
            <div class="skel"></div><div class="skel"></div><div class="skel" style="width:75%"></div>
        </div>`;
}

// ============================================================
// EVENTS (delegation - ek hi listener)
// ============================================================
function setupEvents() {
    $('referralContent').addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('[data-copy]');
        if (copyBtn) {
            try {
                await navigator.clipboard.writeText(copyBtn.dataset.copy);
                const old = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
                setTimeout(() => { copyBtn.innerHTML = old; }, 2000);
            } catch {
                showToast('Copy failed. Please copy manually.', 'error');
            }
            return;
        }

        const tab = e.target.closest('[data-level]');
        if (tab) { showLevel(Number(tab.dataset.level)); return; }

        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        switch (actionEl.dataset.action) {
            case 'more-members':
                levels[activeLevel].visible += MEMBERS_PAGE;
                renderMembers();
                break;
            case 'more-history':
                loadHistory(false);
                break;
            case 'refresh':
                refreshMembers();
                loadHistory(true);
                break;
            case 'retry':
                levels[activeLevel] = { status: 'idle', data: [], visible: MEMBERS_PAGE, promise: null };
                showLevel(activeLevel);
                break;
        }
    });
}

// ============================================================
// LIFECYCLE
// ============================================================
function cleanup() {
    unsubscribers.forEach(off => { try { off(); } catch { /* ignore */ } });
    unsubscribers = [];
    clearTimeout(renderTimer);
}

function start(user) {
    if (currentUserId === user.uid) return; // duplicate auth event par dobara start nahi
    cleanup();
    currentUserId = user.uid;
    summary = {};
    received = new Set();
    shellBuilt = false;
    lastEarningsSig = null;
    showSkeleton();
    startSummaryListeners(user.uid);
}

setupSidebar();
setupEvents();

onAuthStateChanged(auth, (user) => {
    if (!user) {
        cleanup();
        window.location.href = 'login.html';
        return;
    }
    try {
        start(user);
    } catch (err) {
        console.error('Error in auth handler:', err);
        showLoadError();
    }
});

window.addEventListener('beforeunload', cleanup);
