// ============================================================
// RND STAKING - REFERRALS.JS (PRODUCTION READY v13)
// ============================================================
// 🔥 USING PURE v5 LOGIC (Which Works) + Modern Features
// ✅ getAllUsers() - One-time read
// ✅ findMembers() - Recursive traversal (WORKING)
// ✅ directReferrals for Level 1 (Dashboard Compatible)
// ✅ Database Commissions (No Calculation)
// ✅ Email Masking | Status Badge | Share Buttons
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, onValue } from "firebase/database";

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
let currentUserData = null;
let currentUserId = null;
let listenerOff = null;
let historyLimit = 20;
let allUsersCache = null;
let isLoading = false;

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

function formatDate(timestamp) {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleDateString('hi-IN');
}

function safeGet(obj, path, defaultValue = 0) {
    const keys = path.split('.');
    let result = obj;
    for (let key of keys) {
        if (result === undefined || result === null) return defaultValue;
        result = result[key];
    }
    return result !== undefined && result !== null ? result : defaultValue;
}

function maskEmail(email) {
    if (!email) return 'N/A';
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 2) return email;
    return name.substring(0, 2) + '***@' + domain;
}

function getStatusBadge(user) {
    const packages = user.packages || {};
    let hasActive = false;
    let hasCompleted = false;
    
    for (let key in packages) {
        const pkg = packages[key];
        if (pkg.status === 'active') hasActive = true;
        if (pkg.status === 'completed') hasCompleted = true;
    }
    
    if (hasActive) return '<span class="status-badge active">Active</span>';
    if (hasCompleted) return '<span class="status-badge completed">Completed</span>';
    return '<span class="status-badge inactive">Inactive</span>';
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
    try {
        await signOut(auth);
        window.location.href = 'login.html';
    } catch (error) {
        showToast('❌ Error logging out', 'error');
    }
});

// ============================================================
// 🔥 GET LIVE REFERRAL COUNTS (Same as Dashboard)
// ============================================================
function getLiveReferralCounts(userData) {
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
        
        // ✅ Level 1: ONLY from directReferrals
        if (userData.directReferrals) {
            const directKeys = Object.keys(userData.directReferrals);
            result.level1 = directKeys.length;
            result.directReferralsList = directKeys.map(key => userData.directReferrals[key]);
        }
        
        // ✅ Level 2-5: from teamStructure
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
// 🔥 GET ALL USERS (Cached - One Time Read) - v5 LOGIC
// ============================================================
async function getAllUsers() {
    if (allUsersCache) return allUsersCache;
    try {
        const snapshot = await get(ref(db, 'users'));
        if (snapshot.exists()) {
            allUsersCache = snapshot.val();
            return allUsersCache;
        }
        return {};
    } catch (error) {
        console.error('Error getting all users:', error);
        return {};
    }
}

// ============================================================
// 🔥 GET LEVEL MEMBERS (PURE v5 LOGIC - WORKING)
// ============================================================
function getLevelMembersFromCache(userId, referralCode, level) {
    const members = [];
    if (!allUsersCache) return members;
    
    // ✅ Level 1: Direct referrals from user's data
    if (level === 1) {
        if (currentUserData && currentUserData.directReferrals) {
            const directUids = Object.keys(currentUserData.directReferrals);
            for (let uid of directUids) {
                if (allUsersCache[uid]) {
                    const refData = currentUserData.directReferrals[uid];
                    members.push({ uid, ...allUsersCache[uid], _refData: refData });
                } else if (currentUserData.directReferrals[uid]) {
                    members.push({ uid, ...currentUserData.directReferrals[uid] });
                }
            }
        }
        return members;
    }
    
    // ✅ Level 2-5: v5 Recursive traversal (THIS WORKS!)
    function findMembers(refCode, targetLevel, currentLevel) {
        const result = [];
        for (let uid in allUsersCache) {
            const user = allUsersCache[uid];
            // ✅ referredBy contains UID
            if (user.referredBy === refCode && uid !== userId) {
                result.push({ uid, ...user });
            }
        }
        
        if (currentLevel === targetLevel) {
            return result;
        }
        
        let allNext = [];
        for (let member of result) {
            // ✅ Pass member.uid as refCode (because UID is the referral code)
            const next = findMembers(member.uid, targetLevel, currentLevel + 1);
            allNext = [...allNext, ...next];
        }
        return allNext;
    }
    
    // ✅ Start with current user's referral code (UID)
    return findMembers(referralCode, level, 1);
}

// ============================================================
// 🔥 RENDER REFERRAL DATA
// ============================================================
async function renderReferralData(u) {
    if (isLoading) return;
    isLoading = true;
    
    try {
        const username = u.username || u.referralCode || 'USER';
        const name = u.name || 'User';
        
        // ✅ Get live referral counts
        const counts = getLiveReferralCounts(u);
        
        const directReferrals = counts.level1 || 0;
        const level1Count = counts.level1 || 0;
        const level2Count = counts.level2 || 0;
        const level3Count = counts.level3 || 0;
        const level4Count = counts.level4 || 0;
        const level5Count = counts.level5 || 0;
        const totalReferrals = counts.total || 0;
        
        // ✅ Earnings DIRECTLY from Database
        const referralWallet = safeGet(u, 'referralWallet', 0);
        const referralEarnings = safeGet(u, 'referralEarnings', 0);
        
        const level1Earn = safeGet(u, 'level1Earnings', 0);
        const level2Earn = safeGet(u, 'level2Earnings', 0);
        const level3Earn = safeGet(u, 'level3Earnings', 0);
        const level4Earn = safeGet(u, 'level4Earnings', 0);
        const level5Earn = safeGet(u, 'level5Earnings', 0);
        
        const totalDownline = level2Count + level3Count + level4Count + level5Count;
        const totalDownlineEarnings = level2Earn + level3Earn + level4Earn + level5Earn;
        
        const commissionHistory = safeGet(u, 'commissionHistory', []);
        const sortedHistory = [...commissionHistory].reverse();
        const displayHistory = sortedHistory.slice(0, historyLimit);
        const hasMore = sortedHistory.length > historyLimit;
        
        const referralLink = `${REGISTER_URL}?ref=${u.referralCode}`;
        
        // ✅ Get all users (one-time read)
        await getAllUsers();
        
        // ✅ Get Level Members using v5 working logic
        const level1Members = getLevelMembersFromCache(currentUserId, u.referralCode, 1);
        const level2Members = getLevelMembersFromCache(currentUserId, u.referralCode, 2);
        const level3Members = getLevelMembersFromCache(currentUserId, u.referralCode, 3);
        const level4Members = getLevelMembersFromCache(currentUserId, u.referralCode, 4);
        const level5Members = getLevelMembersFromCache(currentUserId, u.referralCode, 5);
        
        // Update sidebar
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
        
        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = totalReferrals;
        
        document.getElementById('referralContent').innerHTML = `
            <div class="row g-4">
                <div class="col-12">
                    <h4 class="fw-bold"><i class="bi bi-people text-success me-2"></i>Referral Program</h4>
                    <hr class="border-secondary">
                </div>
                
                <!-- ====== STATS ====== -->
                <div class="col-12">
                    <div class="stats-grid">
                        <div class="stat-item">
                            <div class="number">${directReferrals}</div>
                            <div class="label">Direct Referrals</div>
                            <div class="earnings">💰 $${(level1Earn || 0).toFixed(2)} Earned</div>
                        </div>
                        <div class="stat-item">
                            <div class="number">${totalDownline}</div>
                            <div class="label">Total Downline</div>
                            <div class="earnings">💰 $${(totalDownlineEarnings || 0).toFixed(2)} Earned</div>
                        </div>
                        <div class="stat-item">
                            <div class="number">${totalReferrals}</div>
                            <div class="label">Total Team</div>
                            <div class="earnings">💰 $${(referralEarnings || 0).toFixed(2)} Total Earned</div>
                        </div>
                    </div>
                </div>
                
                <!-- ====== REFERRAL LINK WITH SHARE BUTTONS ====== -->
                <div class="col-md-6">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-link-45deg"></i>Your Referral Link</div>
                        <div class="referral-box">
                            <code>${referralLink}</code>
                            <button class="copy-btn" data-copy="${referralLink}"><i class="bi bi-clipboard me-1"></i>Copy</button>
                        </div>
                        <div class="mt-2">
                            <small class="text-muted"><i class="bi bi-info-circle me-1"></i> Referral Code: <strong style="color:#2ecc71;font-size:0.7rem;">${u.referralCode}</strong></small>
                        </div>
                        <div class="mt-2">
                            <small class="text-muted"><i class="bi bi-wallet2 me-1"></i> Referral Wallet: <strong style="color:#fbbf24;">${(referralWallet || 0).toFixed(2)} RND</strong></small>
                        </div>
                        <div class="mt-3 pt-2 border-top border-secondary">
                            <span class="text-muted" style="font-size:0.7rem;">Share:</span>
                            <div class="d-flex gap-2 mt-1 flex-wrap">
                                <a href="https://wa.me/?text=${encodeURIComponent('Join RND Staking using my referral link: ' + referralLink)}" target="_blank" class="share-btn whatsapp"><i class="bi bi-whatsapp"></i></a>
                                <a href="https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Join RND Staking using my referral link!')}" target="_blank" class="share-btn telegram"><i class="bi bi-telegram"></i></a>
                                <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(referralLink)}" target="_blank" class="share-btn facebook"><i class="bi bi-facebook"></i></a>
                                <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent('Join RND Staking using my referral link!')}&url=${encodeURIComponent(referralLink)}" target="_blank" class="share-btn twitter"><i class="bi bi-twitter-x"></i></a>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- ====== COMMISSION STRUCTURE ====== -->
                <div class="col-md-6">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3"></i>Commission Structure</div>
                        <div class="row g-2">
                            <div class="col-6"><small>Level 1 (8%)</small></div>
                            <div class="col-6"><small>Level 2 (4%)</small></div>
                            <div class="col-6"><small>Level 3 (2%)</small></div>
                            <div class="col-6"><small>Level 4 (1%)</small></div>
                            <div class="col-6"><small>Level 5 (1%)</small></div>
                            <div class="col-6"><strong class="text-success">Total 16%</strong></div>
                        </div>
                        <div class="mt-3 pt-2 border-top border-secondary">
                            <div class="d-flex justify-content-between">
                                <span class="text-muted">Total Referral Earnings</span>
                                <span class="text-success fw-bold">$${(referralEarnings || 0).toFixed(2)}</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- ====== 5 LEVEL EARNINGS ====== -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-cash-stack text-success me-2"></i>5 Level Referral Earnings</div>
                        <div class="row g-3">
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(46,204,113,0.15);">
                                    <span class="label">👥 Level 1</span>
                                    <span class="value" style="font-size:1rem;">${level1Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#fbbf24;">$${(level1Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(59,130,246,0.15);">
                                    <span class="label">👥 Level 2</span>
                                    <span class="value" style="font-size:1rem;color:#60a5fa;">${level2Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#60a5fa;">$${(level2Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(167,139,250,0.15);">
                                    <span class="label">👥 Level 3</span>
                                    <span class="value" style="font-size:1rem;color:#a78bfa;">${level3Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#a78bfa;">$${(level3Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(244,114,182,0.15);">
                                    <span class="label">👥 Level 4</span>
                                    <span class="value" style="font-size:1rem;color:#f472b6;">${level4Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#f472b6;">$${(level4Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(251,146,60,0.15);">
                                    <span class="label">👥 Level 5</span>
                                    <span class="value" style="font-size:1rem;color:#fb923c;">${level5Count}</span>
                                    <span class="label" style="font-size:0.65rem;color:#fb923c;">$${(level5Earn || 0).toFixed(2)}</span>
                                </div>
                            </div>
                            <div class="col-md-2 col-6">
                                <div class="earnings-box" style="border-color:rgba(46,204,113,0.3);background:rgba(46,204,113,0.05);">
                                    <span class="label">🏆 Total</span>
                                    <span class="value" style="font-size:1.2rem;color:#2ecc71;">${totalReferrals}</span>
                                    <span class="label" style="font-size:0.65rem;color:#2ecc71;">$${(referralEarnings || 0).toFixed(2)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- ====== LEVEL TABLES (All levels always show) ====== -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-list-ul text-success me-2"></i>Level 1 - Direct Referrals (${level1Count}) <span class="level-badge">8%</span></div>
                        ${level1Members.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-people fs-1 d-block mb-2"></i>
                                <p>No referrals yet. Share your referral link to earn!</p>
                            </div>
                        ` : `
                            <div class="level-members-table">
                                <table class="table table-custom">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Name</th>
                                            <th>Email</th>
                                            <th>User ID</th>
                                            <th>Stake</th>
                                            <th>Business</th>
                                            <th>Commission</th>
                                            <th>Status</th>
                                            <th>Joined</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${level1Members.map((r, i) => `
                                            <tr>
                                                <td>${i + 1}</td>
                                                <td>${r.name || r._refData?.name || 'N/A'}</td>
                                                <td style="font-size:0.75rem;">${maskEmail(r.email || r._refData?.email || 'N/A')}</td>
                                                <td style="font-size:0.7rem;color:#a0b8d0;">${r.username || r.referralCode || r.uid?.substring(0, 12)}</td>
                                                <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                                <td>$${(r.teamBusiness || 0).toFixed(2)}</td>
                                                <td style="color:#fbbf24;">$${(r.level1Earnings || 0).toFixed(2)}</td>
                                                <td>${getStatusBadge(r)}</td>
                                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt || r._refData?.joinedAt)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                </div>
                
                <!-- Level 2 -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 2 Referrals (${level2Count}) <span class="level-badge">4%</span></div>
                        ${level2Members.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-people fs-1 d-block mb-2"></i>
                                <p>No referrals at this level yet.</p>
                            </div>
                        ` : `
                            <div class="level-members-table">
                                <table class="table table-custom">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Name</th>
                                            <th>Email</th>
                                            <th>User ID</th>
                                            <th>Stake</th>
                                            <th>Business</th>
                                            <th>Commission</th>
                                            <th>Status</th>
                                            <th>Joined</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${level2Members.map((r, i) => `
                                            <tr>
                                                <td>${i + 1}</td>
                                                <td>${r.name || 'N/A'}</td>
                                                <td style="font-size:0.75rem;">${maskEmail(r.email || 'N/A')}</td>
                                                <td style="font-size:0.7rem;color:#a0b8d0;">${r.username || r.referralCode || r.uid?.substring(0, 12)}</td>
                                                <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                                <td>$${(r.teamBusiness || 0).toFixed(2)}</td>
                                                <td style="color:#60a5fa;">$${(r.level2Earnings || 0).toFixed(2)}</td>
                                                <td>${getStatusBadge(r)}</td>
                                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                </div>
                
                <!-- Level 3 -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 3 Referrals (${level3Count}) <span class="level-badge">2%</span></div>
                        ${level3Members.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-people fs-1 d-block mb-2"></i>
                                <p>No referrals at this level yet.</p>
                            </div>
                        ` : `
                            <div class="level-members-table">
                                <table class="table table-custom">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Name</th>
                                            <th>Email</th>
                                            <th>User ID</th>
                                            <th>Stake</th>
                                            <th>Business</th>
                                            <th>Commission</th>
                                            <th>Status</th>
                                            <th>Joined</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${level3Members.map((r, i) => `
                                            <tr>
                                                <td>${i + 1}</td>
                                                <td>${r.name || 'N/A'}</td>
                                                <td style="font-size:0.75rem;">${maskEmail(r.email || 'N/A')}</td>
                                                <td style="font-size:0.7rem;color:#a0b8d0;">${r.username || r.referralCode || r.uid?.substring(0, 12)}</td>
                                                <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                                <td>$${(r.teamBusiness || 0).toFixed(2)}</td>
                                                <td style="color:#a78bfa;">$${(r.level3Earnings || 0).toFixed(2)}</td>
                                                <td>${getStatusBadge(r)}</td>
                                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                </div>
                
                <!-- Level 4 -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 4 Referrals (${level4Count}) <span class="level-badge">1%</span></div>
                        ${level4Members.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-people fs-1 d-block mb-2"></i>
                                <p>No referrals at this level yet.</p>
                            </div>
                        ` : `
                            <div class="level-members-table">
                                <table class="table table-custom">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Name</th>
                                            <th>Email</th>
                                            <th>User ID</th>
                                            <th>Stake</th>
                                            <th>Business</th>
                                            <th>Commission</th>
                                            <th>Status</th>
                                            <th>Joined</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${level4Members.map((r, i) => `
                                            <tr>
                                                <td>${i + 1}</td>
                                                <td>${r.name || 'N/A'}</td>
                                                <td style="font-size:0.75rem;">${maskEmail(r.email || 'N/A')}</td>
                                                <td style="font-size:0.7rem;color:#a0b8d0;">${r.username || r.referralCode || r.uid?.substring(0, 12)}</td>
                                                <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                                <td>$${(r.teamBusiness || 0).toFixed(2)}</td>
                                                <td style="color:#f472b6;">$${(r.level4Earnings || 0).toFixed(2)}</td>
                                                <td>${getStatusBadge(r)}</td>
                                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                </div>
                
                <!-- Level 5 -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 5 Referrals (${level5Count}) <span class="level-badge">1%</span></div>
                        ${level5Members.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-people fs-1 d-block mb-2"></i>
                                <p>No referrals at this level yet.</p>
                            </div>
                        ` : `
                            <div class="level-members-table">
                                <table class="table table-custom">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Name</th>
                                            <th>Email</th>
                                            <th>User ID</th>
                                            <th>Stake</th>
                                            <th>Business</th>
                                            <th>Commission</th>
                                            <th>Status</th>
                                            <th>Joined</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${level5Members.map((r, i) => `
                                            <tr>
                                                <td>${i + 1}</td>
                                                <td>${r.name || 'N/A'}</td>
                                                <td style="font-size:0.75rem;">${maskEmail(r.email || 'N/A')}</td>
                                                <td style="font-size:0.7rem;color:#a0b8d0;">${r.username || r.referralCode || r.uid?.substring(0, 12)}</td>
                                                <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                                <td>$${(r.teamBusiness || 0).toFixed(2)}</td>
                                                <td style="color:#fb923c;">$${(r.level5Earnings || 0).toFixed(2)}</td>
                                                <td>${getStatusBadge(r)}</td>
                                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                </div>
                
                <!-- ====== COMMISSION HISTORY ====== -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-clock-history text-success me-2"></i>Commission History</div>
                        ${displayHistory.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-inbox fs-1 d-block mb-2"></i>
                                <p>No commission history yet.</p>
                            </div>
                        ` : `
                            <div class="history-scroll">
                                ${displayHistory.map(item => `
                                    <div class="commission-history-item">
                                        <div>
                                            <span class="level-tag">Level ${item.level || 1}</span>
                                            <span class="user">${item.fromUser || 'Unknown'}</span>
                                            ${item.packageId ? `<span class="text-muted" style="font-size:0.6rem;">(${item.packageId.substring(0, 8)})</span>` : ''}
                                        </div>
                                        <div>
                                            <span class="amount">+$${(item.amount || 0).toFixed(2)}</span>
                                            <span class="text-muted" style="font-size:0.6rem;">(${item.percent || 0}%)</span>
                                            <div class="date">${item.date ? formatDate(item.date) : formatDate(item.timestamp)}</div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                            ${hasMore ? `
                                <div class="text-center mt-3">
                                    <button class="load-more-btn" id="loadMoreHistory">
                                        <i class="bi bi-plus-circle me-1"></i> Load More (${sortedHistory.length - historyLimit} remaining)
                                    </button>
                                </div>
                            ` : ''}
                        `}
                    </div>
                </div>
            </div>
        `;
        
        // Copy buttons
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.copy).then(() => {
                    btn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Copied!';
                    setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy'; }, 2000);
                });
            });
        });
        
        // Load More button
        const loadMoreBtn = document.getElementById('loadMoreHistory');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', () => {
                historyLimit += 20;
                renderReferralData(currentUserData);
            });
        }
        
    } catch (error) {
        console.error('Error rendering referral data:', error);
    } finally {
        isLoading = false;
    }
}

// ============================================================
// SETUP REAL-TIME LISTENER
// ============================================================
function setupRealtimeListener(userId) {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
    
    const userRef = ref(db, 'users/' + userId);
    
    listenerOff = onValue(userRef, (snapshot) => {
        try {
            if (!snapshot.exists()) return;
            const data = snapshot.val();
            currentUserData = data;
            allUsersCache = null;
            renderReferralData(data);
        } catch (error) {
            console.error('Realtime listener error:', error);
        }
    });
}

// ============================================================
// LOAD REFERRAL DATA
// ============================================================
async function loadReferralData(userId) {
    try {
        const userSnap = await get(ref(db, 'users/' + userId));
        
        if (!userSnap.exists()) {
            document.getElementById('referralContent').innerHTML = `
                <div class="text-center py-5">
                    <i class="bi bi-exclamation-triangle text-warning fs-1 d-block mb-3"></i>
                    <h4>Profile Not Found</h4>
                    <p class="text-muted">Please complete your profile first.</p>
                    <a href="dashboard.html" class="btn btn-primary-custom mt-3">Go to Dashboard</a>
                </div>
            `;
            return;
        }
        
        const u = userSnap.val();
        currentUserData = u;
        currentUserId = userId;
        
        await renderReferralData(u);
        setupRealtimeListener(userId);
        
    } catch (error) {
        console.error('Error loading referral data:', error);
        document.getElementById('referralContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Unable to Load Referrals</h4>
                <p class="text-muted">Please try again later.</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
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
        await loadReferralData(user.uid);
    } catch (error) {
        console.error('Error in auth handler:', error);
        document.getElementById('referralContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Authentication Error</h4>
                <p class="text-muted">Please try again later.</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
});

// Clean up listener on page unload
window.addEventListener('beforeunload', () => {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
});
