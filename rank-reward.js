// ============================================================
// RANK REWARD - v9
// - एक ही atomic update में सारे eligible rank rewards + deposit wallet credit
// - Wallet में increment() — पुराना balance overwrite होने का खतरा नहीं
// - Firebase download बहुत कम (पूरा user node नहीं, सिर्फ छोटे fields/listeners)
// - Rank transactions (users/{uid}/transactions) और rankRewards पहले जैसे ही बनते हैं
//
// RANK SYSTEM:
// Executive → $3,000 → $100 | Senior Exec → $10,000 → $200
// Manager → $25,000 → $500 | Sr. Manager → $50,000 → $1,000
// Diamond → $100,000 → $2,500
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
    getDatabase,
    ref,
    get,
    onValue,
    update,
    increment
} from "firebase/database";

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
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// RANK THRESHOLDS (CUMULATIVE - NEVER SUBTRACT)
// ============================================================
const RANK_LEVELS = [
    { key: 'member', rank: 'Member', minBusiness: 0, reward: 0, icon: '👤' },
    { key: 'executive', rank: 'Executive', minBusiness: 3000, reward: 100, icon: '📈' },
    { key: 'seniorExecutive', rank: 'Senior Executive', minBusiness: 10000, reward: 200, icon: '⭐' },
    { key: 'manager', rank: 'Manager', minBusiness: 25000, reward: 500, icon: '👔' },
    { key: 'seniorManager', rank: 'Senior Manager', minBusiness: 50000, reward: 1000, icon: '🏆' },
    { key: 'diamond', rank: 'Diamond', minBusiness: 100000, reward: 2500, icon: '💎' }
];

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const iconName = type === 'success' ? 'bi-check-circle-fill' :
        (type === 'error' || type === 'warning') ? 'bi-exclamation-triangle-fill' :
        'bi-info-circle-fill';
    const icon = document.createElement('i');
    icon.className = 'bi ' + iconName;
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

function formatCurrency(amount) {
    const value = Number(amount);
    return '$' + (Number.isFinite(value) ? value : 0).toFixed(2);
}

function formatDateTime(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function generateTxId(suffix = '') {
    return 'rank_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + (suffix ? '_' + suffix : '');
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

// ============================================================
// RANK CALCULATION - BASED ONLY ON teamBusiness
// ============================================================
function calculateRank(teamBusiness) {
    const business = Number(teamBusiness) || 0;
    let current = RANK_LEVELS[0];
    for (const level of RANK_LEVELS) {
        if (business >= level.minBusiness) current = level;
    }
    return current;
}

function getNextRank(teamBusiness) {
    const current = calculateRank(teamBusiness);
    const idx = RANK_LEVELS.findIndex(l => l.key === current.key);
    return idx >= RANK_LEVELS.length - 1 ? null : RANK_LEVELS[idx + 1];
}

function isCompleted(rewards, key) {
    return !!(rewards && rewards[key] && rewards[key].status === 'completed');
}

function calculateTotalRankReward(rewards) {
    let total = 0;
    for (const key in rewards) {
        const r = rewards[key];
        if (r && r.status === 'completed') total += Number(r.rewardAmount) || 0;
    }
    return total;
}

// ============================================================
// 🔥 CLAIM — सारे eligible ranks एक ही ATOMIC update में
// ============================================================
let currentUserId = null;
let profile = {};
let teamBusiness = 0;
let rewards = {};
const ready = { tb: false, rw: false };
let processing = false;
let lastFailAt = 0;
let rewardsErrorShown = false;
const unsubscribers = [];

async function processEligible() {
    if (processing || !currentUserId) return;

    const pending = RANK_LEVELS.filter(l =>
        l.reward > 0 && teamBusiness >= l.minBusiness && !isCompleted(rewards, l.key)
    );
    if (pending.length === 0) return;
    if (Date.now() - lastFailAt < 30000) return;   // fail होने पर बार-बार retry नहीं

    processing = true;
    const uid = currentUserId;
    try {
        // पुराने flag (सिर्फ एक छोटा node)
        const flagsSnap = await get(ref(db, `users/${uid}/_rankRewardsClaimed`));
        const flags = flagsSnap.exists() ? (flagsSnap.val() || {}) : {};

        const now = Date.now();
        const today = getTodayDate();
        const updates = {};
        let credit = 0;
        const credited = [];

        for (const lvl of pending) {
            const baseRecord = {
                rank: lvl.rank,
                rankKey: lvl.key,
                requiredBusiness: lvl.minBusiness,
                rewardAmount: lvl.reward,
                teamBusinessAtReward: teamBusiness,
                creditedAt: now,
                creditedDate: today,
                status: 'completed'
            };

            if (flags[lvl.key] === true) {
                // पहले credit हो चुका था पर rankRewards record नहीं था → सिर्फ record repair (दोबारा पैसा नहीं)
                updates[`rankRewards/${uid}/${lvl.key}`] = {
                    ...baseRecord,
                    transactionId: 'repaired_' + now,
                    source: 'repair_system'
                };
                continue;
            }

            const txId = generateTxId(lvl.key);
            credit += lvl.reward;
            credited.push(lvl.rank);

            updates[`users/${uid}/_rankRewardsClaimed/${lvl.key}`] = true;
            updates[`users/${uid}/transactions/${txId}`] = {
                type: 'rank_reward',
                rank: lvl.rank,
                rankKey: lvl.key,
                amount: lvl.reward,
                currency: 'USDT',
                wallet: 'depositWallet',
                requiredTeamBusiness: lvl.minBusiness,
                teamBusinessAtReward: teamBusiness,
                timestamp: now,
                date: today,
                status: 'completed',
                description: `🏆 ${lvl.rank} Rank Reward: $${lvl.reward} credited to Deposit Wallet`,
                source: 'rank_reward_system_v9',
                atomic: true
            };
            updates[`rankRewards/${uid}/${lvl.key}`] = {
                ...baseRecord,
                transactionId: txId,
                source: 'rank_reward_system_v9',
                atomic: true
            };
        }

        if (credit > 0) {
            updates[`users/${uid}/depositWallet`] = increment(credit);
            updates[`users/${uid}/rank`] = calculateRank(teamBusiness).rank;
        }

        if (Object.keys(updates).length === 0) return;

        // All-or-nothing: या तो wallet + records + transactions सब, या कुछ नहीं
        await update(ref(db), updates);

        if (credited.length > 0) {
            showToast(`🏆 ${credited.join(', ')} rank reward credited to Deposit Wallet!`, 'success');
        }
        // rewards listener अपने आप UI refresh कर देगा
    } catch (error) {
        console.error('❌ Rank reward claim failed:', error);
        lastFailAt = Date.now();
        showToast('❌ Rank reward credit नहीं हुआ। कुछ नहीं कटा/जुड़ा। थोड़ी देर बाद पेज refresh करें।', 'error');
    } finally {
        processing = false;
    }
}

// ============================================================
// RENDER UI (design वही)
// ============================================================
function renderUI(userData, rankRewardStatus) {
    const tb = Number(userData.teamBusiness) || 0;
    const currentRank = calculateRank(tb);
    const nextRank = getNextRank(tb);
    const name = userData.name || 'User';
    const username = String(userData.username || userData.referralCode || 'USER');

    const totalRankReward = calculateTotalRankReward(rankRewardStatus);
    const rewardCount = Object.values(rankRewardStatus)
        .filter(r => r && r.status === 'completed').length;

    document.getElementById('sidebarName').textContent = name;
    document.getElementById('sidebarEmail').textContent = userData.email || 'user@example.com';
    document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
    document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();

    document.getElementById('totalBusiness').textContent = formatCurrency(tb);
    document.getElementById('currentRankDisplay').textContent = currentRank.rank;
    document.getElementById('rankRewardDisplay').textContent = currentRank.reward > 0 ?
        `Reward: ${formatCurrency(currentRank.reward)}` : 'No reward for this rank';
    document.getElementById('totalRankReward').textContent = formatCurrency(totalRankReward);
    document.getElementById('rewardCount').textContent = rewardCount + ' rewards earned';

    document.getElementById('currentRankText').textContent = currentRank.rank + ' ' + currentRank.icon;
    document.getElementById('currentBusinessDisplay').textContent = formatCurrency(tb);

    const nextRankInfo = document.getElementById('nextRankInfo');
    const nextRankText = document.getElementById('nextRankText');
    const needForNext = document.getElementById('needForNext');

    if (nextRank && currentRank.key !== 'diamond') {
        const remaining = Math.max(0, nextRank.minBusiness - tb);
        const progress = Math.min(100, (tb / nextRank.minBusiness) * 100);

        nextRankText.textContent = nextRank.rank + ' ' + nextRank.icon;
        needForNext.textContent = formatCurrency(remaining);
        nextRankInfo.style.display = 'block';

        document.getElementById('rankProgressFill').style.width = progress + '%';
        document.getElementById('progressCurrent').textContent = formatCurrency(tb);
        document.getElementById('progressTarget').textContent = formatCurrency(nextRank.minBusiness);
        document.getElementById('progressPercent').textContent = progress.toFixed(1) + '%';
    } else if (currentRank.key === 'diamond') {
        nextRankText.textContent = '🏆 MAX RANK';
        needForNext.textContent = '$0';
        nextRankInfo.style.display = 'block';
        document.getElementById('rankProgressFill').style.width = '100%';
        document.getElementById('progressCurrent').textContent = formatCurrency(tb);
        document.getElementById('progressTarget').textContent = formatCurrency(tb);
        document.getElementById('progressPercent').textContent = '100%';
    } else {
        nextRankInfo.style.display = 'none';
    }

    const tableBody = document.getElementById('rankTableBody');
    let tableRows = '';

    for (const level of RANK_LEVELS) {
        const isAchieved = isCompleted(rankRewardStatus, level.key);
        const isCurrent = level.key === currentRank.key;
        const isEligible = !isAchieved && tb >= level.minBusiness && level.reward > 0;

        let statusBadge = '';
        if (isAchieved) {
            statusBadge = `<span class="badge-status achieved">✅ Achieved</span>`;
        } else if (isEligible) {
            statusBadge = `<span class="badge-status eligible">⏳ Eligible</span>`;
        } else if (isCurrent) {
            statusBadge = `<span class="badge-status current">Current</span>`;
        } else {
            statusBadge = `<span class="badge-status locked">🔒 Locked</span>`;
        }

        const rewardDisplay = level.reward > 0 ? formatCurrency(level.reward) : '$0';
        const rowClass = isCurrent ? 'style="background:rgba(251,191,36,0.05);"' : '';

        tableRows += `
            <tr ${rowClass}>
                <td><span class="rank-icon-small">${level.icon}</span> ${level.rank}</td>
                <td>${formatCurrency(level.minBusiness)}</td>
                <td>${rewardDisplay}</td>
                <td>${statusBadge}</td>
            </tr>
        `;
    }
    tableBody.innerHTML = tableRows;

    const historyList = document.getElementById('historyList');
    const historyItems = Object.values(rankRewardStatus)
        .filter(r => r && r.status === 'completed')
        .sort((a, b) => (b.creditedAt || 0) - (a.creditedAt || 0));

    if (historyItems.length === 0) {
        historyList.innerHTML = `
            <div class="history-empty">
                <i class="bi bi-clock"></i>
                No rank rewards earned yet.
                <br><span style="font-size:13px;">Build your team business to unlock ranks!</span>
                <br><span style="font-size:12px;color:#556688;">Start with Executive at $3,000</span>
            </div>
        `;
    } else {
        let historyHTML = '';
        for (const item of historyItems) {
            historyHTML += `
                <div class="history-item">
                    <div class="h-left">
                        <div class="h-icon">🏆</div>
                        <div>
                            <div class="h-rank">${escapeHtml(item.rank)}</div>
                            <div class="h-desc">Required: ${formatCurrency(item.requiredBusiness)}</div>
                            <div class="h-desc" style="font-size:11px;color:rgba(255,255,255,0.2);">Tx: ${escapeHtml(item.transactionId || 'N/A')}</div>
                        </div>
                    </div>
                    <div class="h-right">
                        <div class="h-amount">+${formatCurrency(item.rewardAmount)}</div>
                        <div class="h-date">${formatDateTime(item.creditedAt)}</div>
                    </div>
                </div>
            `;
        }
        historyList.innerHTML = historyHTML;
    }
}

// ============================================================
// DATA: सिर्फ 2 छोटे listeners (teamBusiness + rankRewards)
// ============================================================
function showContent() {
    document.getElementById('loadingContainer').style.display = 'none';
    document.getElementById('contentContainer').style.display = 'block';
}

function refresh() {
    if (!(ready.tb && ready.rw)) return;
    renderUI({ ...profile, teamBusiness }, rewards);
    showContent();
    processEligible();
}

async function loadRankData(userId) {
    try {
        document.getElementById('loadingContainer').style.display = 'flex';
        document.getElementById('contentContainer').style.display = 'none';

        // Profile के सिर्फ 4 छोटे fields (पूरा user node नहीं)
        const fields = ['name', 'email', 'username', 'referralCode'];
        const snaps = await Promise.all(fields.map(f => get(ref(db, `users/${userId}/${f}`))));
        if (!snaps.some(s => s.exists())) {
            showToast('❌ User data not found', 'error');
        }
        profile = {};
        fields.forEach((f, i) => { if (snaps[i].exists()) profile[f] = snaps[i].val(); });

        unsubscribers.push(onValue(ref(db, `users/${userId}/teamBusiness`), (snap) => {
            const n = Number(snap.val());
            teamBusiness = Number.isFinite(n) ? n : 0;
            ready.tb = true;
            refresh();
        }, (error) => {
            console.error('teamBusiness listener error:', error);
            ready.tb = true;
            refresh();
        }));

        unsubscribers.push(onValue(ref(db, `rankRewards/${userId}`), (snap) => {
            rewards = snap.exists() ? (snap.val() || {}) : {};
            ready.rw = true;
            refresh();
        }, (error) => {
            console.error('rankRewards listener error:', error);
            if (!rewardsErrorShown) {
                rewardsErrorShown = true;
                showToast('❌ Rank rewards load नहीं हो पाए (permission)।', 'error');
            }
            rewards = {};
            ready.rw = true;
            refresh();
        }));

    } catch (error) {
        console.error('Error loading rank data:', error);
        document.getElementById('loadingContainer').innerHTML = `
            <div style="color:#ef4444;font-size:16px;text-align:center;">
                <i class="bi bi-exclamation-triangle-fill" style="font-size:28px;display:block;margin-bottom:12px;"></i>
                Error loading data: ${escapeHtml(error.message)}
                <br><br>
                <button onclick="location.reload()" style="padding:10px 24px;background:rgba(46,204,113,0.1);border:1px solid rgba(46,204,113,0.2);border-radius:10px;color:#2ecc71;cursor:pointer;">Retry</button>
            </div>
        `;
    }
}

// ============================================================
// CLEANUP
// ============================================================
function cleanup() {
    unsubscribers.forEach((off) => { try { off(); } catch (_) {} });
    unsubscribers.length = 0;
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
    try { await signOut(auth); } catch (err) { console.error(err); }
    window.location.href = 'login.html';
});

// ============================================================
// AUTH HANDLER
// ============================================================
let started = false;
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    if (started) return;
    started = true;
    currentUserId = user.uid;
    await loadRankData(user.uid);
});

window.addEventListener('beforeunload', cleanup);
