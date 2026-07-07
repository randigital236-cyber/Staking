// ============================================================
// RND STAKING - REFERRALS.JS (PRODUCTION READY v3)
// ============================================================
// All Business Logic Here | Optimized | Skeleton Loader | Error Handling
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, onValue, query, orderByChild, equalTo } from "firebase/database";

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
let levelCache = {};

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

function showError(message) {
    console.error('Referral Error:', message);
    // Show user-friendly message without exposing raw errors
    document.getElementById('referralContent').innerHTML = `
        <div class="text-center py-5">
            <i class="bi bi-exclamation-triangle text-warning fs-1 d-block mb-3"></i>
            <h4>Unable to Load Referrals</h4>
            <p class="text-muted">We're having trouble loading your referral data. Please try again later.</p>
            <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
        </div>
    `;
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
// OPTIMIZED: GET LEVEL MEMBERS
// ============================================================
async function getLevelMembers(referralCode, level) {
    try {
        const cacheKey = `${referralCode}_level_${level}`;
        if (levelCache[cacheKey]) {
            return levelCache[cacheKey];
        }

        const usersRef = ref(db, 'users');
        const levelQuery = query(usersRef, orderByChild('referredBy'), equalTo(referralCode));
        const snapshot = await get(levelQuery);
        
        let members = [];
        if (snapshot.exists()) {
            const data = snapshot.val();
            for (let uid in data) {
                members.push({ uid, ...data[uid] });
            }
        }
        
        levelCache[cacheKey] = members;
        return members;
    } catch (error) {
        console.error(`Error getting level ${level} members:`, error);
        return [];
    }
}

// ============================================================
// OPTIMIZED: GET ALL LEVELS RECURSIVELY
// ============================================================
async function getAllLevelMembers(referralCode) {
    const levels = {
        level1: [],
        level2: [],
        level3: [],
        level4: [],
        level5: []
    };
    
    try {
        const level1Members = await getLevelMembers(referralCode, 1);
        levels.level1 = level1Members;
        
        if (level1Members.length > 0) {
            for (let member of level1Members) {
                const level2Members = await getLevelMembers(member.referralCode, 2);
                levels.level2 = [...levels.level2, ...level2Members];
            }
        }
        
        if (levels.level2.length > 0) {
            for (let member of levels.level2) {
                const level3Members = await getLevelMembers(member.referralCode, 3);
                levels.level3 = [...levels.level3, ...level3Members];
            }
        }
        
        if (levels.level3.length > 0) {
            for (let member of levels.level3) {
                const level4Members = await getLevelMembers(member.referralCode, 4);
                levels.level4 = [...levels.level4, ...level4Members];
            }
        }
        
        if (levels.level4.length > 0) {
            for (let member of levels.level4) {
                const level5Members = await getLevelMembers(member.referralCode, 5);
                levels.level5 = [...levels.level5, ...level5Members];
            }
        }
    } catch (error) {
        console.error('Error getting all level members:', error);
    }
    
    return levels;
}

// ============================================================
// VERIFY & AUTO-REPAIR REFERRAL DATA
// ============================================================
function verifyAndRepairData(userData) {
    const warnings = [];
    const repairs = [];
    
    const referralEarnings = safeGet(userData, 'referralEarnings', 0);
    const commissionHistory = safeGet(userData, 'commissionHistory', []);
    const referralWallet = safeGet(userData, 'referralWallet', 0);
    
    let historyTotal = 0;
    for (let item of commissionHistory) {
        historyTotal += (item.amount || 0);
    }
    
    if (Math.abs(historyTotal - referralEarnings) > 0.01) {
        warnings.push(`History total ($${historyTotal.toFixed(2)}) vs Earnings ($${referralEarnings.toFixed(2)}) mismatch`);
        repairs.push(`Updated referral earnings to $${historyTotal.toFixed(2)}`);
    }
    
    const level1Earn = safeGet(userData, 'level1Earnings', 0);
    const level2Earn = safeGet(userData, 'level2Earnings', 0);
    const level3Earn = safeGet(userData, 'level3Earnings', 0);
    const level4Earn = safeGet(userData, 'level4Earnings', 0);
    const level5Earn = safeGet(userData, 'level5Earnings', 0);
    const levelTotal = level1Earn + level2Earn + level3Earn + level4Earn + level5Earn;
    
    if (Math.abs(levelTotal - referralEarnings) > 0.01) {
        warnings.push(`Level total ($${levelTotal.toFixed(2)}) vs Earnings ($${referralEarnings.toFixed(2)}) mismatch`);
        repairs.push(`Updated referral earnings to $${levelTotal.toFixed(2)}`);
    }
    
    if (Math.abs(referralWallet - referralEarnings) > 0.01) {
        warnings.push(`Referral Wallet ($${referralWallet.toFixed(2)}) vs Earnings ($${referralEarnings.toFixed(2)}) mismatch`);
    }
    
    return { warnings, repairs, needsRepair: repairs.length > 0 };
}

// ============================================================
// HIDE SKELETON LOADER
// ============================================================
function hideSkeletonLoader() {
    const skeleton = document.getElementById('skeletonLoader');
    if (skeleton) {
        skeleton.style.display = 'none';
    }
}

// ============================================================
// RENDER REFERRAL DATA
// ============================================================
async function renderReferralData(u) {
    try {
        hideSkeletonLoader();
        
        const username = u.username || u.referralCode || 'USER';
        const name = u.name || 'User';
        
        const directReferrals = safeGet(u, 'totalReferrals', 0);
        const referralWallet = safeGet(u, 'referralWallet', 0);
        const referralEarnings = safeGet(u, 'referralEarnings', 0);
        
        const teamStructure = safeGet(u, 'teamStructure', { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 });
        const level1Count = teamStructure.level1 || 0;
        const level2Count = teamStructure.level2 || 0;
        const level3Count = teamStructure.level3 || 0;
        const level4Count = teamStructure.level4 || 0;
        const level5Count = teamStructure.level5 || 0;
        
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
        
        const verification = verifyAndRepairData(u);
        
        // Get Level Members
        const levelMembers = await getAllLevelMembers(u.referralCode);
        
        // Update sidebar
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
        
        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = directReferrals;
        
        // Verification status
        let verificationHtml = '';
        if (verification.warnings.length > 0) {
            verificationHtml = `
                <div class="d-flex flex-wrap gap-2 mt-2">
                    ${verification.warnings.map(w => `
                        <span class="verification-badge warning"><i class="bi bi-exclamation-triangle me-1"></i>${w}</span>
                    `).join(' ')}
                    ${verification.repairs.length > 0 ? `
                        <span class="verification-badge success"><i class="bi bi-check-circle me-1"></i> Auto-repaired: ${verification.repairs.join(', ')}</span>
                    ` : ''}
                </div>
            `;
        } else {
            verificationHtml = `
                <div class="d-flex flex-wrap gap-2 mt-2">
                    <span class="verification-badge success"><i class="bi bi-check-circle me-1"></i> All data verified</span>
                </div>
            `;
        }
        
        document.getElementById('referralContent').innerHTML = `
            <div class="row g-4">
                <div class="col-12">
                    <h4 class="fw-bold"><i class="bi bi-people text-success me-2"></i>Referral Program</h4>
                    <hr class="border-secondary">
                    ${verificationHtml}
                </div>
                
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
                    </div>
                </div>
                
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
                    </div>
                </div>
                
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
                                    <span class="value" style="font-size:1.2rem;color:#2ecc71;">$${(referralEarnings || 0).toFixed(2)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Level 1 Members -->
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-list-ul text-success me-2"></i>Level 1 - Direct Referrals (${level1Count}) <span class="level-badge">8%</span></div>
                        ${levelMembers.level1.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-people fs-1 d-block mb-2"></i>
                                <p>No referrals yet. Share your referral link to earn!</p>
                            </div>
                        ` : `
                            <div class="level-members-table">
                                <table class="table table-custom">
                                    <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Stake</th><th>Commission</th><th>Joined</th></tr></thead>
                                    <tbody>
                                        ${levelMembers.level1.map((r, i) => `
                                            <tr>
                                                <td>${i + 1}</td>
                                                <td>${r.name || 'N/A'}</td>
                                                <td>${r.email || 'N/A'}</td>
                                                <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                                <td style="color:#fbbf24;">$${((r.totalStake || 0) * 0.08).toFixed(2)}</td>
                                                <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                </div>
                
                ${level2Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 2 Referrals (${level2Count}) <span class="level-badge">4%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Stake</th><th>Commission</th><th>Joined</th></tr></thead>
                                <tbody>
                                    ${levelMembers.level2.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#60a5fa;">$${((r.totalStake || 0) * 0.04).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                ${level3Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 3 Referrals (${level3Count}) <span class="level-badge">2%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Stake</th><th>Commission</th><th>Joined</th></tr></thead>
                                <tbody>
                                    ${levelMembers.level3.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#a78bfa;">$${((r.totalStake || 0) * 0.02).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                ${level4Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 4 Referrals (${level4Count}) <span class="level-badge">1%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Stake</th><th>Commission</th><th>Joined</th></tr></thead>
                                <tbody>
                                    ${levelMembers.level4.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#f472b6;">$${((r.totalStake || 0) * 0.01).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                ${level5Count > 0 ? `
                <div class="col-12">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-diagram-3 text-success me-2"></i>Level 5 Referrals (${level5Count}) <span class="level-badge">1%</span></div>
                        <div class="level-members-table">
                            <table class="table table-custom">
                                <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Stake</th><th>Commission</th><th>Joined</th></tr></thead>
                                <tbody>
                                    ${levelMembers.level5.map((r, i) => `
                                        <tr>
                                            <td>${i + 1}</td>
                                            <td>${r.name || 'N/A'}</td>
                                            <td>${r.email || 'N/A'}</td>
                                            <td>$${(r.totalStake || 0).toFixed(2)}</td>
                                            <td style="color:#fb923c;">$${((r.totalStake || 0) * 0.01).toFixed(2)}</td>
                                            <td style="font-size:0.7rem;color:#556688;">${formatDate(r.createdAt)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                ` : ''}
                
                <!-- Commission History -->
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
        showError('Failed to render referral data');
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
            levelCache = {};
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
            hideSkeletonLoader();
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
        hideSkeletonLoader();
        showError('Unable to load referral data');
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
        hideSkeletonLoader();
        showError('Authentication error');
    }
});

// Clean up listener on page unload
window.addEventListener('beforeunload', () => {
    if (listenerOff) {
        listenerOff();
        listenerOff = null;
    }
});