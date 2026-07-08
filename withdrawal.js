// ============================================================
// RND STAKING PLATFORM - WITHDRAWAL.JS (PRODUCTION READY v3)
// ============================================================

import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import { getDatabase, ref, get, push, runTransaction, set } from "firebase/database";

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
// GLOBALS
// ============================================================
let isProcessing = false;

// ============================================================
// TOAST
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

// ============================================================
// SIDEBAR
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
    await signOut(auth);
    window.location.href = 'login.html';
});

// ============================================================
// GET USER DATA
// ============================================================
async function getUserData(uid) {
    try {
        const snap = await get(ref(db, 'users/' + uid));
        return snap.exists() ? snap.val() : null;
    } catch (error) {
        console.error('Error getting user data:', error);
        return null;
    }
}

// ============================================================
// 🔥 ATOMIC WITHDRAWAL
// ============================================================
async function processAtomicWithdrawal(uid, userData, walletType, amount, address, currency, withdrawalId) {
    const userRef = ref(db, 'users/' + uid);
    
    const result = await runTransaction(userRef, (currentData) => {
        if (!currentData) return { ...currentData };
        
        const balance = currentData[walletType] || 0;
        
        if (balance < amount) {
            console.log('❌ Insufficient balance:', balance, 'Requested:', amount);
            return { ...currentData };
        }
        
        if (walletType === 'referralWallet' && amount < 20) {
            console.log('❌ Minimum 20 USDT required');
            return { ...currentData };
        }
        if (walletType === 'rndWallet' && amount < 5) {
            console.log('❌ Minimum 5 RND required');
            return { ...currentData };
        }
        
        const transactions = currentData.transactions || {};
        for (let key in transactions) {
            const tx = transactions[key];
            if (tx.type === 'withdrawal' && tx.withdrawalId === withdrawalId) {
                console.log('❌ Duplicate withdrawal ID:', withdrawalId);
                return { ...currentData };
            }
        }
        
        const newBalance = balance - amount;
        const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        transactions[txId] = {
            type: 'withdrawal',
            withdrawalId: withdrawalId,
            amount: amount,
            currency: currency,
            walletType: walletType,
            walletAddress: address,
            timestamp: Date.now(),
            date: new Date().toDateString(),
            status: 'pending',
            description: `Withdrawal of ${amount} ${currency}`
        };
        
        return {
            ...currentData,
            [walletType]: newBalance,
            transactions: transactions
        };
    });
    
    if (result.committed) {
        console.log('✅ Atomic withdrawal completed:', withdrawalId);
        
        try {
            const adminRef = ref(db, 'withdrawals');
            const newAdminRef = push(adminRef);
            
            await set(newAdminRef, {
                withdrawalId: withdrawalId,
                uid: uid,
                username: userData.username || userData.referralCode || 'Unknown',
                name: userData.name || 'User',
                email: userData.email || 'N/A',
                walletType: walletType,
                walletAddress: address,
                amount: amount,
                currency: currency,
                status: 'pending',
                createdAt: Date.now(),
                timestamp: Date.now(),
                date: new Date().toDateString()
            });
            
            console.log('✅ Admin withdrawal record created');
        } catch (err) {
            console.warn('⚠️ Admin withdrawal save warning:', err);
        }
        
        return { 
            success: true, 
            withdrawalId: withdrawalId,
            newBalance: result.snapshot.val()[walletType]
        };
    } else {
        console.log('⚠️ Atomic withdrawal failed');
        return { 
            success: false, 
            error: 'Insufficient balance, invalid amount, or duplicate request'
        };
    }
}

// ============================================================
// GET WITHDRAWAL HISTORY
// ============================================================
async function getWithdrawalHistory(uid) {
    try {
        const userSnap = await get(ref(db, 'users/' + uid));
        if (!userSnap.exists()) return [];
        
        const userData = userSnap.val();
        const transactions = userData.transactions || {};
        const withdrawals = [];
        
        for (let key in transactions) {
            const tx = transactions[key];
            if (tx.type === 'withdrawal') {
                withdrawals.push({ id: key, ...tx });
            }
        }
        
        withdrawals.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return withdrawals;
    } catch (error) {
        console.error('Error getting withdrawal history:', error);
        return [];
    }
}

// ============================================================
// 🔥 MAIN AUTH HANDLER - WITH ERROR HANDLING
// ============================================================
onAuthStateChanged(auth, async (user) => {
    // ============================================================
    // STEP 1: CHECK USER LOGIN
    // ============================================================
    if (!user) {
        console.log('❌ No user logged in, redirecting to login...');
        window.location.href = 'login.html';
        return;
    }

    try {
        console.log('✅ User logged in:', user.uid);
        
        // ============================================================
        // STEP 2: GET USER DATA
        // ============================================================
        const userData = await getUserData(user.uid);
        console.log('📊 User data:', userData ? 'Found' : 'Not Found');
        
        if (!userData) {
            console.log('⚠️ User data not found, redirecting to dashboard...');
            window.location.href = 'dashboard.html';
            return;
        }
        
        // ============================================================
        // STEP 3: UPDATE SIDEBAR
        // ============================================================
        const username = userData.username || userData.referralCode || 'USER';
        const name = userData.name || 'User';
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username.substring(0, 20) + '...';
        document.getElementById('sidebarAvatar').textContent = name.charAt(0).toUpperCase();
        
        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = userData.totalReferrals || 0;

        // ============================================================
        // STEP 4: GET WITHDRAWAL HISTORY
        // ============================================================
        const withdrawals = await getWithdrawalHistory(user.uid);

        // ============================================================
        // STEP 5: READ WALLETS
        // ============================================================
        const depositWallet = userData.depositWallet || 0;
        const referralWallet = userData.referralWallet || 0;
        const rndWallet = userData.rndWallet || 0;
        const lockedRND = userData.lockedRND || 0;

        // ============================================================
        // STEP 6: BALANCE CHECK
        // ============================================================
        const isReferralSufficient = referralWallet >= 20;
        const isRNDSufficient = rndWallet >= 5;
        const canWithdraw = isReferralSufficient || isRNDSufficient;

        // ============================================================
        // STEP 7: RENDER HTML
        // ============================================================
        document.getElementById('withdrawalContent').innerHTML = `
            <div class="row g-4">
                <div class="col-12">
                    <h4 class="fw-bold"><i class="bi bi-arrow-up-circle text-success me-2"></i>Withdraw Funds</h4>
                    <hr class="border-secondary">
                </div>

                <!-- ====== WALLETS ====== -->
                <div class="col-12">
                    <div class="row g-3">
                        <div class="col-6 col-lg-3">
                            <div class="wallet-box">
                                <div class="wallet-icon deposit"><i class="bi bi-wallet2"></i></div>
                                <div class="wallet-number green">$${depositWallet.toFixed(2)}</div>
                                <div class="wallet-label">Deposit Wallet</div>
                                <div class="wallet-sub">USDT Balance</div>
                                <div class="wallet-disabled-badge">🔒 Not for Withdrawal</div>
                            </div>
                        </div>
                        <div class="col-6 col-lg-3">
                            <div class="wallet-box">
                                <div class="wallet-icon referral"><i class="bi bi-coin"></i></div>
                                <div class="wallet-number gold">${referralWallet.toFixed(2)}</div>
                                <div class="wallet-label">💰 Referral Wallet</div>
                                <div class="wallet-sub">USDT Balance</div>
                                <div class="min-label referral-min">⚠️ Min: 20 USDT (BEP20)</div>
                                ${isReferralSufficient 
                                    ? '<div class="wallet-enabled-badge">✅ Can Withdraw</div>'
                                    : '<div class="wallet-disabled-badge">❌ Insufficient (Min 20 USDT)</div>'
                                }
                            </div>
                        </div>
                        <div class="col-6 col-lg-3">
                            <div class="wallet-box">
                                <div class="wallet-icon rnd"><i class="bi bi-database"></i></div>
                                <div class="wallet-number blue">${rndWallet.toFixed(4)}</div>
                                <div class="wallet-label">RND Wallet</div>
                                <div class="wallet-sub">RND Balance</div>
                                <div class="min-label rnd-min">⚠️ Min: 5 RND (BEP20)</div>
                                ${isRNDSufficient 
                                    ? '<div class="wallet-enabled-badge">✅ Can Withdraw</div>'
                                    : '<div class="wallet-disabled-badge">❌ Insufficient (Min 5 RND)</div>'
                                }
                            </div>
                        </div>
                        <div class="col-6 col-lg-3">
                            <div class="wallet-box">
                                <div class="wallet-icon locked"><i class="bi bi-lock"></i></div>
                                <div class="wallet-number" style="color:#a78bfa;">${lockedRND.toFixed(2)}</div>
                                <div class="wallet-label">🔒 Locked RND</div>
                                <div class="wallet-sub">Total - Released</div>
                                <div class="wallet-disabled-badge">🔒 Not for Withdrawal</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- ====== WITHDRAWAL FORM ====== -->
                <div class="col-lg-7 mx-auto">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-arrow-up-circle text-success me-2"></i>Request Withdrawal</div>
                        
                        <div class="alert alert-warning" style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.15);color:#fbbf24;border-radius:12px;">
                            <small><i class="bi bi-info-circle me-1"></i> 
                                <strong>Referral Wallet:</strong> Min 20 USDT (BEP20) &nbsp;|&nbsp; 
                                <strong>RND Wallet:</strong> Min 5 RND (BEP20)
                            </small>
                        </div>

                        ${!canWithdraw ? `
                            <div class="alert-insufficient">
                                <i class="bi bi-exclamation-triangle"></i>
                                <strong>❌ Insufficient Balance!</strong><br>
                                <small>You need at least 20 USDT in Referral Wallet OR 5 RND in RND Wallet to withdraw.</small>
                            </div>
                        ` : ''}

                        <!-- ====== WITHDRAWAL OPTIONS ====== -->
                        <div class="row g-2 mb-3">
                            <div class="col-6">
                                <div class="withdraw-option-card ${isReferralSufficient ? 'selected' : 'disabled'}" 
                                     id="optionReferral" 
                                     onclick="${isReferralSufficient ? "selectWithdrawOption('referralWallet')" : ''}"
                                     style="${!isReferralSufficient ? 'opacity:0.5;cursor:not-allowed;' : ''}">
                                    <div class="option-icon">💳</div>
                                    <div class="option-label">Referral Wallet</div>
                                    <div class="option-balance">${referralWallet.toFixed(2)} USDT</div>
                                    <div class="min-label referral-min">Min: 20 USDT (BEP20)</div>
                                    <div class="option-status ${isReferralSufficient ? 'sufficient' : 'insufficient'}">
                                        ${isReferralSufficient ? '✅ Sufficient Balance' : '❌ Insufficient Balance'}
                                    </div>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="withdraw-option-card ${isRNDSufficient ? 'selected' : 'disabled'}" 
                                     id="optionRND" 
                                     onclick="${isRNDSufficient ? "selectWithdrawOption('rndWallet')" : ''}"
                                     style="${!isRNDSufficient ? 'opacity:0.5;cursor:not-allowed;' : ''}">
                                    <div class="option-icon">📊</div>
                                    <div class="option-label">RND Wallet</div>
                                    <div class="option-balance">${rndWallet.toFixed(4)} RND</div>
                                    <div class="min-label rnd-min">Min: 5 RND (BEP20)</div>
                                    <div class="option-status ${isRNDSufficient ? 'sufficient' : 'insufficient'}">
                                        ${isRNDSufficient ? '✅ Sufficient Balance' : '❌ Insufficient Balance'}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <form id="withdrawForm">
                            <div class="mb-3">
                                <label class="form-label">Selected Wallet <span class="required">*</span></label>
                                <input type="text" id="selectedWalletDisplay" class="form-control form-control-custom" 
                                       value="${isReferralSufficient ? 'Referral Wallet (USDT - BEP20)' : isRNDSufficient ? 'RND Wallet (RND - BEP20)' : 'No Wallet Available'}" readonly>
                                <input type="hidden" id="selectedWallet" value="${isReferralSufficient ? 'referralWallet' : isRNDSufficient ? 'rndWallet' : ''}">
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Amount <span class="required">*</span></label>
                                <input type="number" id="withAmount" class="form-control form-control-custom" 
                                       placeholder="Enter amount" min="1" step="0.01" required ${!canWithdraw ? 'disabled' : ''}>
                                <small class="text-muted" style="font-size:0.7rem;" id="minAmountHint">
                                    ${isReferralSufficient ? 'Minimum: 20 USDT (BEP20) for Referral Wallet' : 
                                      isRNDSufficient ? 'Minimum: 5 RND (BEP20) for RND Wallet' : 
                                      'No wallet available for withdrawal'}
                                </small>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Wallet Address (BEP20) <span class="required">*</span></label>
                                <input type="text" id="withAddr" class="form-control form-control-custom" 
                                       placeholder="0x..." required ${!canWithdraw ? 'disabled' : ''}>
                                <small class="text-muted" style="font-size:0.7rem;">Enter your BEP20 wallet address</small>
                            </div>
                            <button type="submit" class="btn-primary-custom" id="withdrawBtn" ${!canWithdraw ? 'disabled' : ''}>
                                <i class="bi bi-arrow-up-circle me-2"></i>
                                ${!canWithdraw ? '❌ Insufficient Balance' : 'Submit Withdrawal'}
                            </button>
                        </form>

                        <div class="mt-3">
                            <a href="dashboard.html" class="btn-outline-custom w-100 text-center"><i class="bi bi-arrow-left me-1"></i> Back to Dashboard</a>
                        </div>
                    </div>
                </div>

                <!-- ====== WITHDRAWAL HISTORY ====== -->
                <div class="col-lg-7 mx-auto">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-clock-history text-success me-2"></i>Withdrawal History</div>
                        ${withdrawals.length === 0 ? `
                            <div class="text-center text-muted py-4">
                                <i class="bi bi-inbox fs-1 d-block mb-2"></i>
                                <p>No withdrawal requests yet.</p>
                            </div>
                        ` : `
                            <div style="max-height:300px;overflow-y:auto;">
                                ${withdrawals.map((w) => {
                                    let statusHtml = '';
                                    if (w.status === 'pending') statusHtml = '<span class="status-pending"><i class="bi bi-clock me-1"></i>Pending</span>';
                                    else if (w.status === 'approved') statusHtml = '<span class="status-approved"><i class="bi bi-check-circle me-1"></i>Approved</span>';
                                    else if (w.status === 'rejected') statusHtml = '<span class="status-rejected"><i class="bi bi-x-circle me-1"></i>Rejected</span>';
                                    else statusHtml = '<span class="status-pending">Pending</span>';
                                    
                                    const currency = w.currency || 'RND';
                                    const walletLabel = w.walletType === 'referralWallet' ? '💳 Referral' : '📊 RND';
                                    
                                    return `
                                        <div class="transaction-item">
                                            <div>
                                                <div class="amount">${w.amount} ${currency}</div>
                                                <div style="font-size:0.7rem;color:#8899bb;">${walletLabel}</div>
                                                <div class="date">${new Date(w.timestamp).toLocaleString('hi-IN')}</div>
                                                ${w.walletAddress ? `<div style="font-size:0.6rem;color:#556688;font-family:monospace;">${w.walletAddress.substring(0, 20)}...</div>` : ''}
                                            </div>
                                            <div>${statusHtml}</div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        `}
                    </div>
                </div>
            </div>
        `;

        // ============================================================
        // STEP 8: SELECT WITHDRAW OPTION
        // ============================================================
        window.selectWithdrawOption = function(walletType) {
            const isReferralSufficient = ${referralWallet >= 20};
            const isRNDSufficient = ${rndWallet >= 5};
            
            if (walletType === 'referralWallet' && !isReferralSufficient) {
                showToast('❌ Insufficient balance in Referral Wallet! Min 20 USDT required.', 'error');
                return;
            }
            if (walletType === 'rndWallet' && !isRNDSufficient) {
                showToast('❌ Insufficient balance in RND Wallet! Min 5 RND required.', 'error');
                return;
            }
            
            document.querySelectorAll('.withdraw-option-card').forEach(el => el.classList.remove('selected'));
            
            if (walletType === 'referralWallet') {
                document.getElementById('optionReferral').classList.add('selected');
                document.getElementById('selectedWalletDisplay').value = 'Referral Wallet (USDT - BEP20)';
                document.getElementById('selectedWallet').value = 'referralWallet';
                document.getElementById('minAmountHint').textContent = 'Minimum: 20 USDT (BEP20) for Referral Wallet';
                document.getElementById('minAmountHint').style.color = '#fbbf24';
            } else if (walletType === 'rndWallet') {
                document.getElementById('optionRND').classList.add('selected');
                document.getElementById('selectedWalletDisplay').value = 'RND Wallet (RND - BEP20)';
                document.getElementById('selectedWallet').value = 'rndWallet';
                document.getElementById('minAmountHint').textContent = 'Minimum: 5 RND (BEP20) for RND Wallet';
                document.getElementById('minAmountHint').style.color = '#60a5fa';
            }
        };

        // ============================================================
        // STEP 9: FORM SUBMIT
        // ============================================================
        document.getElementById('withdrawForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            if (isProcessing) {
                showToast('⚠️ Please wait, processing...', 'error');
                return;
            }
            
            const walletType = document.getElementById('selectedWallet').value;
            const amount = parseFloat(document.getElementById('withAmount').value);
            const address = document.getElementById('withAddr').value.trim();
            const btn = document.getElementById('withdrawBtn');

            if (!walletType) {
                showToast('❌ No wallet available for withdrawal!', 'error');
                return;
            }

            if (!amount || isNaN(amount) || amount <= 0) {
                showToast('❌ Please enter a valid amount!', 'error');
                return;
            }

            const freshUserData = await getUserData(user.uid);
            if (!freshUserData) {
                showToast('❌ Unable to fetch user data. Please try again.', 'error');
                return;
            }
            
            const currentBalance = freshUserData[walletType] || 0;

            // ============================================================
            // 🔒 BALANCE VALIDATION
            // ============================================================
            if (walletType === 'referralWallet') {
                if (amount < 20) {
                    showToast('❌ Minimum withdrawal for Referral Wallet is 20 USDT!', 'error');
                    return;
                }
                if (amount > currentBalance) {
                    showToast(`❌ Insufficient balance! You have ${currentBalance.toFixed(2)} USDT`, 'error');
                    return;
                }
            } else if (walletType === 'rndWallet') {
                if (amount < 5) {
                    showToast('❌ Minimum withdrawal for RND Wallet is 5 RND!', 'error');
                    return;
                }
                if (amount > currentBalance) {
                    showToast(`❌ Insufficient balance! You have ${currentBalance.toFixed(4)} RND`, 'error');
                    return;
                }
            } else {
                showToast('❌ Invalid wallet selected!', 'error');
                return;
            }

            if (!address || !address.startsWith('0x') || address.length < 10) {
                showToast('❌ Please enter a valid BEP20 wallet address starting with 0x', 'error');
                return;
            }

            const currency = walletType === 'referralWallet' ? 'USDT' : 'RND';
            const withdrawalId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);

            isProcessing = true;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';

            try {
                const result = await processAtomicWithdrawal(
                    user.uid,
                    freshUserData,
                    walletType,
                    amount,
                    address,
                    currency,
                    withdrawalId
                );
                
                if (!result.success) {
                    showToast('❌ ' + (result.error || 'Withdrawal failed. Please try again.'), 'error');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-arrow-up-circle me-2"></i>Submit Withdrawal';
                    isProcessing = false;
                    return;
                }

                showToast(`✅ Withdrawal request submitted successfully! ${amount} ${currency} is pending admin approval.`, 'success');
                document.getElementById('withAmount').value = '';
                document.getElementById('withAddr').value = '';
                
                setTimeout(() => {
                    window.location.reload();
                }, 2500);

            } catch (error) {
                console.error('Withdrawal error:', error);
                showToast('❌ Error submitting withdrawal. Please try again.', 'error');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-up-circle me-2"></i>Submit Withdrawal';
                isProcessing = false;
            }
        });

    } catch (error) {
        console.error('❌ Error loading withdrawal page:', error);
        document.getElementById('withdrawalContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Page</h4>
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
                <br>
                <a href="dashboard.html" class="btn-outline-custom mt-3">Back to Dashboard</a>
            </div>
        `;
    }
});
