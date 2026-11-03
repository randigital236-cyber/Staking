import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get } from "firebase/database";

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

// Sidebar Logic
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

// Helpers
function formatDate(timestamp) {
    if (!timestamp) return 'N/A';
    const d = new Date(timestamp);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(timestamp) {
    if (!timestamp) return 'N/A';
    const d = new Date(timestamp);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getInvoiceNumber(pkg, userId, index) {
    if (pkg.invoiceNumber) return pkg.invoiceNumber;
    const shortId = (userId || "USER").substring(0, 8).toUpperCase();
    const count = String(index + 1).padStart(4, '0');
    return `INV-${shortId}-${count}`;
}

function getMemberSince(userData) {
    return userData.createdAt || userData.registrationDate || userData.joinDate || userData.timestamp || Date.now();
}

function getCompletionDate(pkg) {
    if (pkg.completedDate) return pkg.completedDate;
    if (pkg.completedAt) return pkg.completedAt;
    if (pkg.completionDate) return pkg.completionDate;
    const purchaseDate = pkg.purchaseDate || pkg.timestamp;
    const planDays = pkg.planDays || 0;
    if (purchaseDate && planDays > 0) return purchaseDate + (planDays * 24 * 60 * 60 * 1000);
    return null;
}

function getReleasedPercent(released, total) {
    if (!total || total === 0) return 0;
    return (released / total) * 100;
}

function getTimelineText(daysRemaining, progress) {
    if (daysRemaining === 0) return '⏳ Completing today!';
    if (daysRemaining <= 3) return `⏳ ${daysRemaining} day${daysRemaining > 1 ? 's' : ''} remaining`;
    if (daysRemaining <= 7) return `📅 ${daysRemaining} days to go`;
    if (progress > 75) return `🔥 ${progress.toFixed(0)}% completed`;
    if (progress > 50) return `📈 ${progress.toFixed(0)}% released`;
    return `🔒 ${daysRemaining} days remaining`;
}

function calculateEndDate(startDate, planDays) {
    if (!startDate || !planDays) return null;
    return startDate + (planDays * 24 * 60 * 60 * 1000);
}

function getDaysRemaining(endDate) {
    if (!endDate) return 0;
    const now = Date.now();
    const diff = endDate - now;
    if (diff <= 0) return 0;
    return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function getDaysPassed(startDate) {
    if (!startDate) return 0;
    const diff = Date.now() - startDate;
    if (diff <= 0) return 0;
    return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function getPlanColor(planName) {
    const colors = { '6 Months Plan': '#2ecc71', '12 Months Plan': '#fbbf24', '18 Months Plan': '#f472b6' };
    return colors[planName] || '#2ecc71';
}

// Main Logic
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    try {
        const userSnap = await get(ref(db, 'users/' + user.uid));
        if (!userSnap.exists()) {
            window.location.href = 'dashboard.html';
            return;
        }
        
        const userData = userSnap.val();
        const username = userData.username || userData.referralCode || 'USER';
        const name = userData.name || 'User';
        const uid = user.uid;
        
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
        
        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = userData.totalReferrals || 0;

        const packages = userData.packages || {};
        const packageKeys = Object.keys(packages);
        
        if (packageKeys.length === 0) {
            document.getElementById('invoiceContent').innerHTML = `
                <div class="invoice-container">
                    <div class="invoice-card">
                        <div class="empty-state">
                            <i class="bi bi-box-seam"></i>
                            <h4>No Packages Found</h4>
                            <p>You haven't purchased any staking packages yet.</p>
                            <a href="buy-package.html" class="btn btn-primary-custom mt-3" style="background:linear-gradient(135deg, #2ecc71, #27ae60); border:none; color:#fff; padding:10px 24px; border-radius:12px; text-decoration:none; display:inline-block; font-weight:600;">
                                <i class="bi bi-plus-circle me-1"></i> Buy Your First Package
                            </a>
                        </div>
                    </div>
                </div>
            `;
            return;
        }

        let totalInvested = 0;
        let totalRNDReceived = 0;
        let totalReleased = 0;
        let totalLocked = 0;
        let activePackages = 0;
        let completedPackages = 0;

        packageKeys.forEach(key => {
            const pkg = packages[key];
            if (pkg.status === 'active' || pkg.status === 'completed') {
                totalInvested += (pkg.usdtAmount || 0);
                totalRNDReceived += (pkg.totalRND || 0);
                totalReleased += (pkg.releasedRND || 0);
                const locked = (pkg.totalRND || 0) - (pkg.releasedRND || 0);
                totalLocked += Math.max(0, locked);
                if (pkg.status === 'active') activePackages++;
                else completedPackages++;
            }
        });

        const releasedPercent = getReleasedPercent(totalReleased, totalRNDReceived);
        const memberSince = getMemberSince(userData);

        let packagesHtml = '';
        packageKeys.forEach((key, index) => {
            const pkg = packages[key];
            const isActive = pkg.status === 'active';
            const totalRND = pkg.totalRND || 0;
            const releasedRND = pkg.releasedRND || 0;
            const remainingRND = pkg.remainingRND || 0;
            const dailyRelease = pkg.dailyRelease || 0;
            const planDays = pkg.planDays || 0;
            const purchaseDate = pkg.purchaseDate || pkg.timestamp || Date.now();
            const endDate = calculateEndDate(purchaseDate, planDays);
            const daysRemaining = isActive ? getDaysRemaining(endDate) : 0;
            const daysPassed = getDaysPassed(purchaseDate);
            const progress = getReleasedPercent(releasedRND, totalRND);
            const planColor = getPlanColor(pkg.planName);
            const invoiceNumber = getInvoiceNumber(pkg, uid, index);
            
            const completionDate = getCompletionDate(pkg);
            const completionDateStr = completionDate ? formatDateShort(completionDate) : 'Completed';
            const timelineText = isActive ? getTimelineText(daysRemaining, progress) : '✅ Package completed successfully';
            
            let timelineHtml = '';
            if (isActive) {
                const progressPercent = progress / 100;
                const lockPercent = 1 - progressPercent;
                timelineHtml = `
                    <div class="timeline-bar">
                        <div class="segment lock" style="flex:${Math.max(lockPercent * 10, 0.5)};">🔒 ${timelineText}</div>
                        <div class="segment release" style="flex:${Math.max(progressPercent * 10, 0.5)};">📈 ${progress.toFixed(1)}% Released</div>
                    </div>
                `;
            } else {
                timelineHtml = `
                    <div class="timeline-bar">
                        <div class="segment completed" style="flex:10;">✅ ${completionDateStr}</div>
                    </div>
                `;
            }

            packagesHtml += `
                <div class="package-item">
                    <div class="pkg-header">
                        <div>
                            <span class="pkg-name" style="color:${planColor};">${pkg.planName || 'Package'}</span>
                            <span class="plan-badge ${!isActive ? 'completed' : ''} ms-2">${isActive ? '🟢 Active' : '🔵 Completed'}</span>
                            <span class="status-badge ${isActive ? 'active' : 'completed'} ms-1">
                                <i class="bi ${isActive ? 'bi-clock' : 'bi-check-circle'}"></i> ${isActive ? 'In Progress' : 'Completed'}
                            </span>
                            <span class="invoice-number-badge ms-2"><i class="bi bi-receipt me-1"></i>${invoiceNumber}</span>
                        </div>
                        <div><span style="font-size:0.7rem;color:#64748b;">#${key.substring(0, 8)}</span></div>
                    </div>
                    
                    <div class="pkg-details">
                        <div class="detail"><div class="val" style="color:#2ecc71;">$${(pkg.usdtAmount || 0).toFixed(2)}</div><div class="lbl">Investment</div></div>
                        <div class="detail"><div class="val" style="color:#60a5fa;">${totalRND.toFixed(2)}</div><div class="lbl">Total RND</div></div>
                        <div class="detail"><div class="val" style="color:#fbbf24;">${releasedRND.toFixed(2)}</div><div class="lbl">Released</div></div>
                        <div class="detail"><div class="val" style="color:#a78bfa;">${remainingRND.toFixed(2)}</div><div class="lbl">Remaining</div></div>
                        <div class="detail"><div class="val" style="color:#34d399;">${dailyRelease.toFixed(4)}</div><div class="lbl">Daily</div></div>
                        <div class="detail"><div class="val" style="color:#f472b6;">${pkg.bonusPercent || 0}%</div><div class="lbl">Bonus</div></div>
                        <div class="detail"><div class="val" style="color:#94a3c4;font-size:0.8rem;">${formatDateShort(purchaseDate)}</div><div class="lbl">Start Date</div></div>
                        <div class="detail"><div class="val" style="color:${isActive ? '#fbbf24' : '#60a5fa'};font-size:0.8rem;">${isActive ? formatDateShort(endDate) : completionDateStr}</div><div class="lbl">${isActive ? 'End Date' : 'Completion'}</div></div>
                        <div class="detail"><div class="val" style="color:#34d399;font-size:0.8rem;">${isActive ? daysPassed + ' days' : 'Done'}</div><div class="lbl">Passed</div></div>
                        <div class="detail"><div class="val" style="color:#fbbf24;font-size:0.8rem;">${isActive ? daysRemaining + ' days' : '0'}</div><div class="lbl">Remaining</div></div>
                    </div>
                    
                    ${timelineHtml}
                    
                    <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:#64748b;margin-top:4px;flex-wrap:wrap;gap:4px;">
                        <span>📊 ${progress.toFixed(1)}% Released</span>
                        <span>${isActive ? '⏳ ' + daysRemaining + ' days' : '✅ All released'}</span>
                        <span>💰 Rate: $${(pkg.rndPriceAtTime || 1).toFixed(4)}</span>
                        <span>📅 ${planDays} Days</span>
                    </div>
                </div>
            `;
        });

        document.getElementById('invoiceContent').innerHTML = `
            <div class="invoice-container">
                <div class="invoice-card">
                    <div class="invoice-header">
                        <div>
                            <div class="brand"><i class="bi bi-currency-bitcoin"></i>RND Staking</div>
                            <div style="font-size:0.7rem;color:#64748b;margin-top:4px;">
                                <span class="invoice-number-screen">
                                    <span class="invoice-number-badge"><i class="bi bi-receipt me-1"></i>Statement #${packageKeys.length > 0 ? getInvoiceNumber(packages[packageKeys[0]], uid, 0) : 'N/A'}</span>
                                </span>
                                <span class="invoice-number-print">
                                    <span class="invoice-number-badge"><i class="bi bi-receipt me-1"></i>Statement #${packageKeys.length > 0 ? getInvoiceNumber(packages[packageKeys[0]], uid, 0) : 'N/A'}</span>
                                </span>
                            </div>
                        </div>
                        <div><span class="badge-domain"><i class="bi bi-check-circle-fill me-1"></i> staking.randigital.in</span></div>
                    </div>

                    <div class="d-flex justify-content-between align-items-start flex-wrap mb-3">
                        <div>
                            <div class="invoice-title">📄 Package Statement</div>
                            <div class="invoice-sub">Complete history of all your staking packages</div>
                        </div>
                        <div class="text-end">
                            <span style="font-size:0.85rem;color:#fff;font-weight:600;"><i class="bi bi-person me-1"></i> ${name}</span>
                            <div style="font-size:0.7rem;color:#64748b;margin-top:2px;"><i class="bi bi-calendar me-1"></i> Generated: ${formatDate(Date.now())}</div>
                        </div>
                    </div>

                    <div style="background:rgba(8,14,26,0.3);border-radius:12px;padding:12px 16px;margin-bottom:15px;border:1px solid rgba(255,255,255,0.06);">
                        <div class="detail-row"><span class="detail-label">User Name</span><span class="detail-value highlight">${name}</span></div>
                        <div class="detail-row"><span class="detail-label">User ID</span><span class="detail-value" style="font-family:monospace;color:#60a5fa;">${username}</span></div>
                        <div class="detail-row"><span class="detail-label">Email</span><span class="detail-value">${userData.email || 'N/A'}</span></div>
                        <div class="detail-row"><span class="detail-label">Member Since</span><span class="detail-value">${formatDate(memberSince)}</span></div>
                    </div>

                    <div class="summary-grid">
                        <div class="summary-item"><div class="num green">${packageKeys.length}</div><div class="label">Total Packages</div></div>
                        <div class="summary-item"><div class="num gold">$${totalInvested.toFixed(2)}</div><div class="label">Total Invested</div></div>
                        <div class="summary-item"><div class="num blue">${totalRNDReceived.toFixed(2)}</div><div class="label">Total RND</div></div>
                        <div class="summary-item"><div class="num purple">${totalReleased.toFixed(2)}</div><div class="label">Total Released</div></div>
                    </div>

                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:10px 0 20px;">
                        <div style="background:rgba(8,14,26,0.3);border-radius:10px;padding:10px;text-align:center;border:1px solid rgba(255,255,255,0.06);"><div style="font-size:1.2rem;font-weight:700;color:#2ecc71;">${activePackages}</div><div style="font-size:0.6rem;color:#94a3c4;">🟢 Active</div></div>
                        <div style="background:rgba(8,14,26,0.3);border-radius:10px;padding:10px;text-align:center;border:1px solid rgba(255,255,255,0.06);"><div style="font-size:1.2rem;font-weight:700;color:#60a5fa;">${completedPackages}</div><div style="font-size:0.6rem;color:#94a3c4;">🔵 Completed</div></div>
                        <div style="background:rgba(8,14,26,0.3);border-radius:10px;padding:10px;text-align:center;border:1px solid rgba(255,255,255,0.06);"><div style="font-size:1.2rem;font-weight:700;color:#a78bfa;">${totalLocked.toFixed(2)}</div><div style="font-size:0.6rem;color:#94a3c4;">🔒 Locked</div></div>
                        <div style="background:rgba(8,14,26,0.3);border-radius:10px;padding:10px;text-align:center;border:1px solid rgba(255,255,255,0.06);"><div style="font-size:1.2rem;font-weight:700;color:#34d399;">${releasedPercent.toFixed(1)}%</div><div style="font-size:0.6rem;color:#94a3c4;">✅ Released %</div></div>
                    </div>

                    <div class="package-list">
                        <h6 style="font-weight:700;color:#fff;margin-bottom:15px;"><i class="bi bi-box-seam text-success me-2"></i>Package Details (${packageKeys.length} packages)</h6>
                        ${packagesHtml}
                    </div>

                    <div class="d-flex flex-wrap justify-content-between align-items-center mt-4">
                        <div><span style="font-size:0.7rem;color:#64748b;"><i class="bi bi-shield-check me-1"></i> All data is secured and stored on Firebase</span></div>
                        <div>
                            <button class="btn-print" onclick="window.print()"><i class="bi bi-printer"></i> Print / PDF</button>
                            <a href="dashboard.html" class="btn-outline-print ms-2"><i class="bi bi-arrow-left"></i> Back</a>
                        </div>
                    </div>

                    <div class="footer-note">
                        <i class="bi bi-info-circle me-1"></i> This is a system-generated statement of all your staking packages. Each package releases a fixed amount daily (totalRND / planDays). Release starts from the day after purchase. For any queries, please contact support.
                    </div>
                </div>
            </div>
        `;

    } catch (error) {
        console.error('Error loading invoice:', error);
        document.getElementById('invoiceContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Page</h4>
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
});