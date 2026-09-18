// ============================================================
// 🔥 WITHDRAWAL PAGE LOGIC - RND STAKING (v5 - Financial Safe)
// ============================================================
// 🔥 Security features:
//   - Idempotency key (requestId) prevents double submission
//   - Server-side balance re-verification via runTransaction
//   - Atomic balance deduction + transaction record
//   - Pending request tracking (survives refresh/back/multiple tabs)
//   - Network error safe: reply with UNKNOWN state, don't double-charge
//   - Hardened amount & address validation
//   - ✅ v4: INSTANT UI lock (button hides on first click)
//   - ✅ v4: Inline progress loader (no multiple toasts)
//   - ✅ v4: finally-block always releases lock
//   - ✅ v5: deducted/deductedAmount/deductedFromWallet tracking
//   - ✅ v5: Refund-safe reject support from admin panel
//   - ✅ v5: Root withdrawal push wrapped safely
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, set, push, runTransaction, remove } from "firebase/database";

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

console.log('✅ Firebase initialized with NEW config (rnd2-70080)');

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// 🔥 CONSTANTS
// ============================================================
const WITHDRAW_CONFIG = {
    referralWallet: { min: 20, currency: 'USDT', label: 'Referral Wallet' },
    rndWallet:      { min: 5,  currency: 'RND',  label: 'RND Wallet' }
};

// 🔥 BEP20 address validation regex
const BEP20_REGEX = /^0x[a-fA-F0-9]{40}$/;

// ============================================================
// 🔥 UTILITY
// ============================================================
function roundTo8(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100000000) / 100000000;
}

function generateRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'wd_req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

function showToast(message, type = 'success') {
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

    toast.innerHTML = `
        <i class="bi ${icons[type] || icons.info}" style="color:${colors[type] || colors.info};"></i>
        <span class="toast-msg">${message}</span>
    `;

    container.appendChild(toast);

    const duration = type === 'error' ? 8000 : type === 'warning' ? 7000 : 5000;
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
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
// 🔥 GET USER DATA
// ============================================================
async function getUserData(uid) {
    const snap = await get(ref(db, 'users/' + uid));
    return snap.exists() ? snap.val() : null;
}

// ============================================================
// 🔥 GET WITHDRAWAL HISTORY
// ============================================================
async function getWithdrawalHistory(uid) {
    const userSnap = await get(ref(db, 'users/' + uid));
    if (!userSnap.exists()) return [];

    const userData = userSnap.val();
    const transactions = userData.transactions || {};
    const withdrawals = [];

    for (let key in transactions) {
        const tx = transactions[key];
        if (tx && tx.type === 'withdrawal') {
            withdrawals.push({ id: key, ...tx });
        }
    }

    withdrawals.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return withdrawals;
}

// ============================================================
// 🔥 CHECK DUPLICATE REQUEST (Idempotency)
// ============================================================
async function checkDuplicateRequest(uid, requestId) {
    try {
        const snap = await get(ref(db, `users/${uid}/withdrawalRequests/${requestId}`));
        if (snap.exists()) {
            return { isDuplicate: true, data: snap.val() };
        }
        return { isDuplicate: false };
    } catch (err) {
        console.warn('Duplicate check error:', err);
        return { isDuplicate: false };
    }
}

// ============================================================
// 🔥 RESERVE REQUEST SLOT (Atomic)
// ============================================================
async function reserveRequestSlot(uid, requestId, payload) {
    const slotRef = ref(db, `users/${uid}/withdrawalRequests/${requestId}`);
    try {
        const result = await runTransaction(slotRef, (currentData) => {
            if (currentData !== null) {
                return; // abort — duplicate
            }
            return {
                requestId,
                uid,
                walletType: payload.walletType,
                amount: payload.amount,
                currency: payload.currency,
                address: payload.address,
                status: 'processing',
                createdAt: Date.now()
            };
        });
        return result.committed;
    } catch (err) {
        console.error('Reserve slot error:', err);
        return false;
    }
}

// ============================================================
// 🔥 UPDATE REQUEST SLOT
// ============================================================
async function updateRequestSlot(uid, requestId, updates) {
    try {
        const slotRef = ref(db, `users/${uid}/withdrawalRequests/${requestId}`);
        const snap = await get(slotRef);
        const existing = snap.exists() ? snap.val() : {};
        await set(slotRef, { ...existing, ...updates });
    } catch (err) {
        console.warn('Could not update request slot:', err);
    }
}

// ============================================================
// 🔥 ATOMIC WITHDRAWAL PROCESS (Hardened v5)
// ============================================================
// 🔥 v5 Changes:
//   - Added: deducted, deductedAmount, deductedFromWallet
//   - These fields allow admin reject to trigger a refund
//   - Prevents double processing via withdrawalId + requestId
// ============================================================
async function processAtomicWithdrawal(uid, walletType, amount, address, currency, withdrawalId, requestId) {
    const userRef = ref(db, 'users/' + uid);
    const now = Date.now();

    try {
        const result = await runTransaction(userRef, (currentData) => {
            if (!currentData) {
                return null; // abort — user not found
            }

            // ============================================================
            // STEP 1: Check if this withdrawalId OR requestId already exists
            // ============================================================
            const transactions = currentData.transactions || {};
            for (let key in transactions) {
                const tx = transactions[key];
                if (!tx || tx.type !== 'withdrawal') continue;

                // ✅ Duplicate by withdrawalId
                if (tx.withdrawalId === withdrawalId) {
                    console.warn('⚠️ Withdrawal already exists (by withdrawalId):', withdrawalId);
                    return; // abort
                }
                // ✅ Duplicate by requestId (extra safety)
                if (requestId && tx.requestId === requestId) {
                    console.warn('⚠️ Withdrawal already exists (by requestId):', requestId);
                    return; // abort
                }
            }

            // ============================================================
            // STEP 2: Strictly validate balance and amount
            // ============================================================
            const balance = roundTo8(currentData[walletType] || 0);
            const amt = roundTo8(amount);

            if (!Number.isFinite(balance) || balance < 0) {
                console.warn('⚠️ Invalid wallet balance:', balance);
                return null;
            }

            if (!Number.isFinite(amt) || amt <= 0) {
                console.warn('⚠️ Invalid withdrawal amount:', amt);
                return null;
            }

            if (balance < amt) {
                console.warn('⚠️ Insufficient balance in transaction:', balance, 'needed:', amt);
                return null; // abort — insufficient
            }

            // ============================================================
            // STEP 3: Compute and validate new balance
            // ============================================================
            const newBalance = roundTo8(balance - amt);

            if (newBalance < 0 || !Number.isFinite(newBalance)) {
                console.warn('⚠️ Invalid resulting balance:', newBalance);
                return null;
            }

            // ============================================================
            // STEP 4: Create transaction record (with deduction tracking)
            // ============================================================
            const txId = 'wd_' + now + '_' + Math.random().toString(36).substr(2, 8);
            transactions[txId] = {
                type: 'withdrawal',
                withdrawalId: withdrawalId,
                requestId: requestId,
                amount: amt,
                currency: currency,
                walletType: walletType,
                walletAddress: address,
                timestamp: now,
                date: new Date().toDateString(),
                status: 'pending',
                description: `Withdrawal of ${amt} ${currency} to ${address.substring(0, 15)}...`,

                // ============================================================
                // 🔥 v5: DEDUCTION TRACKING (for admin reject → refund)
                // ============================================================
                deducted: true,                    // amount was deducted from wallet
                deductedAmount: amt,               // how much was deducted
                deductedFromWallet: walletType,    // which wallet
                deductedAt: now,                   // when
                refunded: false                    // will be set true if admin rejects
            };

            return {
                ...currentData,
                [walletType]: newBalance,
                transactions: transactions
            };
        });

        if (result.committed && result.snapshot && result.snapshot.exists()) {
            const updated = result.snapshot.val();
            const newBal = roundTo8(updated[walletType] || 0);
            console.log('✅ Atomic withdrawal committed:', withdrawalId, '| New balance:', newBal);
            return { success: true, withdrawalId, newBalance: newBal };
        } else {
            console.warn('⚠️ Atomic withdrawal not committed (insufficient or duplicate):', withdrawalId);
            return { success: false, error: 'Insufficient balance or duplicate request' };
        }

    } catch (err) {
        console.error('❌ Atomic withdrawal error:', err);
        return { success: false, error: err.message || 'Transaction failed' };
    }
}

// ============================================================
// 🔥 RECONCILE PENDING REQUESTS
// ============================================================
async function reconcilePendingRequests(uid) {
    try {
        const reqRef = ref(db, `users/${uid}/withdrawalRequests`);
        const snap = await get(reqRef);
        if (!snap.exists()) return [];

        const requests = snap.val();
        const results = [];

        for (const [requestId, data] of Object.entries(requests)) {
            if (!data || data.status !== 'processing') continue;

            const userSnap = await get(ref(db, 'users/' + uid));
            const userData = userSnap.exists() ? userSnap.val() : null;
            const transactions = userData?.transactions || {};

            let txFound = false;
            for (let key in transactions) {
                const tx = transactions[key];
                if (tx && tx.type === 'withdrawal' && tx.requestId === requestId) {
                    txFound = true;
                    break;
                }
            }

            if (txFound) {
                await updateRequestSlot(uid, requestId, {
                    status: 'completed',
                    completedAt: Date.now()
                });
                results.push({ requestId, status: 'completed' });
            } else {
                await remove(ref(db, `users/${uid}/withdrawalRequests/${requestId}`));
                results.push({ requestId, status: 'failed' });
            }
        }

        return results;
    } catch (err) {
        console.warn('Reconcile error:', err);
        return [];
    }
}

// ============================================================
// 🔥 RENDER WITHDRAWAL UI
// ============================================================
function renderWithdrawalUI(userData, withdrawals) {
    const container = document.getElementById('withdrawalContent');
    if (!container) return;

    const depositWallet  = Number(userData.depositWallet) || 0;
    const referralWallet = Number(userData.referralWallet) || 0;
    const rndWallet      = Number(userData.rndWallet) || 0;
    const lockedRND      = Number(userData.lockedRND) || 0;

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
            if (w.status === 'pending')        statusHtml = '<span class="status-pending"><i class="bi bi-clock"></i>Pending</span>';
            else if (w.status === 'approved')  statusHtml = '<span class="status-approved"><i class="bi bi-check-circle-fill"></i>Approved</span>';
            else if (w.status === 'rejected')  statusHtml = '<span class="status-rejected"><i class="bi bi-x-circle-fill"></i>Rejected</span>';
            else                                statusHtml = '<span class="status-pending">Pending</span>';

            const currency = w.currency || 'RND';
            const walletLabel = w.walletType === 'referralWallet' ? '💳 Referral Wallet' : '📊 RND Wallet';
            const dateStr = w.timestamp ? new Date(w.timestamp).toLocaleString('en-IN') : 'N/A';

            return `
                <div class="transaction-item">
                    <div>
                        <div class="amount">${Number(w.amount).toFixed(4)} ${currency}</div>
                        <div style="font-size:0.72rem;color:var(--text-secondary);margin-top:2px;">${walletLabel}</div>
                        <div class="date">${dateStr}</div>
                        ${w.walletAddress ? `<div style="font-size:0.62rem;color:var(--text-muted);font-family:'Courier New',monospace;margin-top:2px;">${w.walletAddress.substring(0, 24)}...</div>` : ''}
                    </div>
                    <div>${statusHtml}</div>
                </div>
            `;
        }).join('') + `</div>`;
    }

    container.innerHTML = `
        <div class="row g-4">
            <!-- Page Header -->
            <div class="col-12">
                <div class="page-header-section">
                    <h4><i class="bi bi-arrow-up-circle"></i> Withdraw Funds</h4>
                    <span class="badge-mini-pill pill-green"><i class="bi bi-shield-check"></i> Secure Withdrawal</span>
                </div>
            </div>

            <!-- Wallet Cards -->
            <div class="col-12">
                <div class="row g-3">
                    <div class="col-6 col-lg-3">
                        <div class="wallet-card-new deposit">
                            <div class="wallet-card-header">
                                <span class="wallet-card-label">Deposit Wallet</span>
                                <div class="wallet-card-icon"><i class="bi bi-wallet2"></i></div>
                            </div>
                            <div class="wallet-card-value">
                                $${depositWallet.toFixed(2)}
                                <span class="wallet-card-currency">USDT</span>
                            </div>
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
                            <div class="wallet-card-value">
                                ${referralWallet.toFixed(2)}
                                <span class="wallet-card-currency">USDT</span>
                            </div>
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
                            <div class="wallet-card-value">
                                ${rndWallet.toFixed(4)}
                                <span class="wallet-card-currency">RND</span>
                            </div>
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
                            <div class="wallet-card-value">
                                ${lockedRND.toFixed(2)}
                                <span class="wallet-card-currency">RND</span>
                            </div>
                            <div class="wallet-card-footer">
                                <i class="bi bi-lock-fill"></i>
                                <span class="badge-mini-pill pill-red">🔒 Locked</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Withdraw Form -->
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

                    <!-- Option Cards -->
                    <div class="row g-2 mb-3">
                        <div class="col-6">
                            <div class="withdraw-option-card selected" id="optionReferral" data-wallet="referralWallet">
                                <div class="option-icon">💳</div>
                                <div class="option-label">Referral Wallet</div>
                                <div class="option-balance">${referralWallet.toFixed(2)} USDT</div>
                                <div class="min-label referral-min">Min: 20 USDT (BEP20)</div>
                            </div>
                        </div>
                        <div class="col-6">
                            <div class="withdraw-option-card" id="optionRND" data-wallet="rndWallet">
                                <div class="option-icon">📊</div>
                                <div class="option-label">RND Wallet</div>
                                <div class="option-balance">${rndWallet.toFixed(4)} RND</div>
                                <div class="min-label rnd-min">Min: 5 RND (BEP20)</div>
                            </div>
                        </div>
                    </div>

                    <form id="withdrawForm" autocomplete="off">
                        <div class="mb-3">
                            <label class="form-label" for="selectedWalletDisplay">Selected Wallet <span class="required">*</span></label>
                            <input type="text" id="selectedWalletDisplay" class="form-control form-control-custom" value="Referral Wallet (USDT - BEP20)" readonly>
                            <input type="hidden" id="selectedWallet" value="referralWallet">
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="withAmount">Amount <span class="required">*</span></label>
                            <input type="number" id="withAmount" class="form-control form-control-custom"
                                   placeholder="Enter amount" min="0.00000001" step="any" required>
                            <small class="form-hint" id="minAmountHint">Minimum: 20 USDT (BEP20) for Referral Wallet</small>
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="withAddr">Wallet Address (BEP20) <span class="required">*</span></label>
                            <input type="text" id="withAddr" class="form-control form-control-custom"
                                   placeholder="0x..." required>
                            <small class="form-hint">Enter your BEP20 wallet address (must start with 0x)</small>
                        </div>
                        <button type="submit" class="btn-primary-custom" id="withdrawBtn">
                            <i class="bi bi-arrow-up-circle"></i>
                            <span>Submit Withdrawal</span>
                        </button>

                        <!-- 🔥 v4: Processing Loader (hidden by default) -->
                        <div id="withdrawLoader" style="display:none; margin-top:14px;">
                            <div class="withdraw-progress-box">
                                <div class="withdraw-progress-spinner"></div>
                                <div class="withdraw-progress-text">
                                    <strong>Processing Withdrawal...</strong>
                                    <span>Checking network → Verifying balance → Submitting</span>
                                </div>
                            </div>
                        </div>
                    </form>

                    <div class="mt-3">
                        <a href="dashboard.html" class="btn-outline-custom">
                            <i class="bi bi-arrow-left"></i> Back to Dashboard
                        </a>
                    </div>
                </div>
            </div>

            <!-- Withdrawal History -->
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
// 🔥 WITHDRAW OPTION SWITCHER
// ============================================================
function attachOptionHandlers() {
    const optionReferral = document.getElementById('optionReferral');
    const optionRND = document.getElementById('optionRND');

    function selectOption(walletType) {
        document.querySelectorAll('.withdraw-option-card').forEach(el => el.classList.remove('selected'));

        if (walletType === 'referralWallet') {
            optionReferral.classList.add('selected');
            document.getElementById('selectedWalletDisplay').value = 'Referral Wallet (USDT - BEP20)';
            document.getElementById('selectedWallet').value = 'referralWallet';
            const hint = document.getElementById('minAmountHint');
            hint.textContent = 'Minimum: 20 USDT (BEP20) for Referral Wallet';
            hint.style.color = '#fbbf24';
        } else {
            optionRND.classList.add('selected');
            document.getElementById('selectedWalletDisplay').value = 'RND Wallet (RND - BEP20)';
            document.getElementById('selectedWallet').value = 'rndWallet';
            const hint = document.getElementById('minAmountHint');
            hint.textContent = 'Minimum: 5 RND (BEP20) for RND Wallet';
            hint.style.color = '#60a5fa';
        }
    }

    if (optionReferral) optionReferral.addEventListener('click', () => selectOption('referralWallet'));
    if (optionRND) optionRND.addEventListener('click', () => selectOption('rndWallet'));
}

// ============================================================
// 🔥 ATTACH WITHDRAW FORM HANDLER (v5 - Financial Safe)
// ============================================================
function attachWithdrawHandler(user) {
    const form = document.getElementById('withdrawForm');
    if (!form) return;

    let isSubmitting = false;

    function lockUI() {
        const btn = document.getElementById('withdrawBtn');
        const loader = document.getElementById('withdrawLoader');
        if (btn) {
            btn.disabled = true;
            btn.style.display = 'none';
        }
        if (loader) loader.style.display = 'flex';
    }

    function unlockUI() {
        const btn = document.getElementById('withdrawBtn');
        const loader = document.getElementById('withdrawLoader');
        if (loader) loader.style.display = 'none';
        if (btn) {
            btn.disabled = false;
            btn.style.display = '';
            btn.innerHTML = '<i class="bi bi-arrow-up-circle"></i> <span>Submit Withdrawal</span>';
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // ============================================================
        // 🔥 LAYER 1: Instant double-click block
        // ============================================================
        if (isSubmitting) {
            showToast('⏳ Please wait, aapka request already process ho raha hai...', 'warning');
            return;
        }

        isSubmitting = true;
        lockUI();

        const walletType = document.getElementById('selectedWallet').value;
        const amountRaw = document.getElementById('withAmount').value;
        const address = document.getElementById('withAddr').value.trim();

        const cfg = WITHDRAW_CONFIG[walletType];

        try {
            // ============================================================
            // 🔥 LAYER 2: Wallet config validation
            // ============================================================
            if (!cfg) {
                showToast('❌ Invalid wallet selected.', 'error');
                return;
            }

            // ============================================================
            // 🔥 LAYER 3: Hardened frontend validation
            // ============================================================
            const amount = Number(amountRaw);

            if (!Number.isFinite(amount) || amount <= 0) {
                showToast('❌ Please enter a valid amount greater than 0.', 'error');
                return;
            }

            const amountString = String(amountRaw).trim();
            const decimalPart = amountString.includes('.') ? amountString.split('.')[1] : '';

            if (decimalPart.length > 8) {
                showToast('❌ Maximum 8 decimal places are allowed.', 'error');
                return;
            }

            if (amount < cfg.min) {
                showToast(`❌ Minimum withdrawal for ${cfg.label} is ${cfg.min} ${cfg.currency} (BEP20).`, 'error');
                return;
            }

            if (!BEP20_REGEX.test(address)) {
                showToast('❌ Please enter a valid BEP20 wallet address.', 'error');
                return;
            }

            // ============================================================
            // 🔥 LAYER 4: Fresh balance from server
            // ============================================================
            const freshUser = await getUserData(user.uid);

            if (!freshUser) {
                showToast('❌ Unable to verify your balance. Please try again.', 'error');
                return;
            }

            const freshBalance = Number(freshUser[walletType]);

            if (!Number.isFinite(freshBalance) || freshBalance < 0) {
                showToast('❌ Unable to verify your balance. Please try again.', 'error');
                return;
            }

            if (freshBalance < amount) {
                showToast(
                    `❌ Insufficient balance! You have only ${freshBalance.toFixed(4)} ${cfg.currency}.`,
                    'error'
                );
                return;
            }

            // ============================================================
            // 🔥 LAYER 5: Idempotency keys
            // ============================================================
            const requestId = generateRequestId();
            const withdrawalId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);

            // ============================================================
            // 🔥 LAYER 6: Duplicate check (server-side)
            // ============================================================
            const dupCheck = await checkDuplicateRequest(user.uid, requestId);
            if (dupCheck.isDuplicate) {
                showToast('⚠️ Yeh request already process ho chuki hai.', 'warning');
                return;
            }

            // ============================================================
            // 🔥 LAYER 7: Reserve request slot atomically
            // ============================================================
            const reserved = await reserveRequestSlot(user.uid, requestId, {
                walletType, amount, currency: cfg.currency, address
            });

            if (!reserved) {
                showToast('⏳ Yeh request already process ho rahi hai. Please wait...', 'warning');
                return;
            }

            // ============================================================
            // 🔥 LAYER 8: Atomic withdrawal on Firebase
            // ============================================================
            const result = await processAtomicWithdrawal(
                user.uid,
                walletType,
                amount,
                address,
                cfg.currency,
                withdrawalId,
                requestId
            );

            if (!result.success) {
                await updateRequestSlot(user.uid, requestId, {
                    status: 'failed',
                    error: result.error,
                    failedAt: Date.now()
                });
                showToast('❌ ' + (result.error || 'Withdrawal failed. Please try again.'), 'error');
                return;
            }

            // ============================================================
            // 🔥 LAYER 9: Mark slot completed
            // ============================================================
            await updateRequestSlot(user.uid, requestId, {
                status: 'completed',
                withdrawalId,
                completedAt: Date.now()
            });

            // ============================================================
            // 🔥 LAYER 10: Push to root withdrawals (admin visibility)
            // 🔥 v5: Wrapped safely — even if this fails, main tx is done
            // ============================================================
            try {
                await push(ref(db, 'withdrawals'), {
                    uid: user.uid,
                    withdrawalId,
                    requestId,
                    amount,
                    currency: cfg.currency,
                    walletType,
                    wallet: address,
                    status: 'pending',
                    timestamp: Date.now(),

                    // 🔥 v5: Mirror deduction tracking for admin refund logic
                    deducted: true,
                    deductedAmount: amount,
                    deductedFromWallet: walletType,
                    deductedAt: Date.now(),
                    refunded: false
                });
            } catch (err) {
                console.warn('Root withdrawal save warning (non-critical):', err);
                // Main transaction is already committed — no rollback needed
            }

            // ✅ SUCCESS
            showToast(
                `✅ Withdrawal request submitted! ${amount} ${cfg.currency} will be processed by admin.`,
                'success'
            );

            document.getElementById('withAmount').value = '';
            document.getElementById('withAddr').value = '';

            setTimeout(() => { window.location.reload(); }, 2000);
            return;

        } catch (err) {
            console.error('Withdrawal error:', err);

            if (err?.message?.includes('network') || err?.code === 'NETWORK_ERROR') {
                showToast(
                    '⚠️ Network issue — aapka request process ho sakti hai. DO NOT submit again. Page refresh karke check karein.',
                    'warning'
                );
            } else {
                showToast('❌ Error submitting withdrawal. Please try again.', 'error');
            }

        } finally {
            isSubmitting = false;
            unlockUI();
        }
    });
}

// ============================================================
// 🔥 MAIN
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    try {
        try {
            await reconcilePendingRequests(user.uid);
        } catch (err) {
            console.warn('Reconcile skipped:', err);
        }

        const userData = await getUserData(user.uid);
        if (!userData) {
            window.location.href = 'dashboard.html';
            return;
        }

        const username = userData.username || userData.referralCode || 'USER';
        const name = userData.name || 'User';
        const sidebarName = document.getElementById('sidebarName');
        const sidebarUserId = document.getElementById('sidebarUserId');
        const sidebarAvatar = document.getElementById('sidebarAvatar');
        const referralBadge = document.getElementById('referralBadge');

        if (sidebarName) sidebarName.textContent = name;
        if (sidebarUserId) sidebarUserId.textContent = 'ID: ' + username.substring(0, 20) + (username.length > 20 ? '...' : '');
        if (sidebarAvatar) sidebarAvatar.textContent = name.charAt(0).toUpperCase();
        if (referralBadge) referralBadge.textContent = userData.totalReferrals || 0;

        const withdrawals = await getWithdrawalHistory(user.uid);

        renderWithdrawalUI(userData, withdrawals);
        attachOptionHandlers();
        attachWithdrawHandler(user);

    } catch (error) {
        console.error('Error loading withdrawal page:', error);
        const container = document.getElementById('withdrawalContent');
        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 60px 20px;">
                    <i class="bi bi-exclamation-triangle" style="color:var(--red);opacity:0.8;"></i>
                    <h4 style="color:#fff;margin-bottom:8px;">Error Loading Page</h4>
                    <p style="color:var(--text-muted);margin-bottom:20px;">
                        ${error.message || 'Please check your internet connection.'}
                    </p>
                    <button class="btn-primary-custom" onclick="location.reload()" style="max-width:200px;margin:0 auto;">
                        <i class="bi bi-arrow-clockwise"></i> Refresh Page
                    </button>
                </div>
            `;
        }
    }
});
