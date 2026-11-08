import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, get, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.esm.min.js";

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
// CONSTANTS
// ============================================================
const DEST_CURRENCY = 'USDT';
const RATE_REFRESH_MS = 30000;

// 🔥 Multiple RPC fallback
const BSC_RPCS = [
    "https://bsc-dataseed.binance.org/",
    "https://bsc-dataseed1.defibit.io/",
    "https://bsc-dataseed1.ninicoin.io/",
    "https://rpc.ankr.com/bsc",
    "https://bsc.publicnode.com"
];

const QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const RND_TOKEN = "0xcF1FbF18bE9202865bcf88E6349B9D207F75942d";
const USDT_TOKEN = "0x55d398326f99059fF775485246999027B3197955";
const WBNB_TOKEN = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const FEE_TIERS = [100, 500, 2500, 10000];

// ============================================================
// STATE
// ============================================================
let currentUserId = null;
let liveRate = 0;
let rateReady = false;
let isFallbackRate = false;
let rateFetchSeq = 0;
let walletReady = false;
let isConnected = true;
let rndBalance = 0;
let swapInProgress = false;
let uiInitialized = false;
let rateTimer = null;
let balanceListenerOff = null;

// 🔒 Rate lock state
let rateLocked = false;
let lockedRate = 0;
let lockedAmount = 0;
let lockedDestWallet = null;
let lockedUsdtPreview = 0;

// ============================================================
// DOM HELPERS
// ============================================================
const $ = (id) => document.getElementById(id);
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

// ============================================================
// UTILITIES
// ============================================================
function showToast(message, type = 'success') {
    const container = $('toastContainer');
    if (!container) { if (type !== 'success') alert(message); return; }
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = document.createElement('i');
    icon.className = 'bi ' + (type === 'success' ? 'bi-check-circle-fill text-success' : 'bi-exclamation-triangle-fill text-danger');
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

function getTodayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function generateTxId() {
    const rand = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
        : Math.random().toString(36).slice(2, 12);
    return 'swap_' + Date.now() + '_' + rand;
}

function roundTo(value, precision) {
    const f = Math.pow(10, precision);
    return Math.round((value + Number.EPSILON) * f) / f;
}

function fmtRnd(n) { return Number(n || 0).toFixed(4) + ' RND'; }
function fmtUsdt(n) { return Number(n || 0).toFixed(2) + ' ' + DEST_CURRENCY; }

function isOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
}

// ============================================================
// VALIDATION
// ============================================================
function validateAmount(raw) {
    const amount = parseFloat(raw);
    if (raw === '' || raw === null || raw === undefined) return { ok: false, amount: 0, error: null };
    if (!isFinite(amount) || amount <= 0) return { ok: false, amount: 0, error: 'Enter a valid amount' };
    if (Math.abs(roundTo(amount, 4) - amount) > 1e-9) return { ok: false, amount, error: 'Maximum 4 decimals allowed' };
    if (rateReady && roundTo(amount * liveRate, 2) <= 0) return { ok: false, amount, error: 'Amount too small' };
    if (walletReady && amount > rndBalance) return { ok: false, amount, error: 'Insufficient RND balance' };
    return { ok: true, amount, error: null };
}

// ============================================================
// RPC HELPER (Multi-fallback)
// ============================================================
async function getHealthyProvider() {
    for (const rpc of BSC_RPCS) {
        try {
            const p = new ethers.providers.StaticJsonRpcProvider(rpc, 56);
            const blockNum = await Promise.race([
                p.getBlockNumber(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
            ]);
            if (blockNum > 0) return p;
        } catch (e) {
            // next RPC
        }
    }
    throw new Error('All RPCs failed');
}

// ============================================================
// ✅ FIXED: fetchLiveRate with sequence guard (ignore stale)
// ============================================================
async function fetchLiveRate() {
    // 🔒 अगर rate lock हो चुका है, तो background update से liveRate बदलो, 
    // लेकिन lockedRate पर कोई असर नहीं
    const mySeq = ++rateFetchSeq;

    try {
        const provider = await getHealthyProvider();
        if (mySeq !== rateFetchSeq) return false; // stale

        const quoterAbi = [
            "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
        ];
        const quoter = new ethers.Contract(QUOTER_V2, quoterAbi, provider);
        const amountIn = ethers.utils.parseUnits("1", 18);

        let foundRate = 0;

        // Direct RND → USDT
        for (const fee of FEE_TIERS) {
            try {
                const params = {
                    tokenIn: RND_TOKEN,
                    tokenOut: USDT_TOKEN,
                    amountIn: amountIn,
                    fee: fee,
                    sqrtPriceLimitX96: 0
                };
                const result = await quoter.callStatic.quoteExactInputSingle(params);
                if (result.amountOut > 0) {
                    foundRate = parseFloat(ethers.utils.formatUnits(result.amountOut, 18));
                    break;
                }
            } catch (e) { /* try next fee */ }
        }

        // Fallback: RND → WBNB → USDT
        if (foundRate === 0) {
            for (const fee of FEE_TIERS) {
                try {
                    const params1 = {
                        tokenIn: RND_TOKEN,
                        tokenOut: WBNB_TOKEN,
                        amountIn: amountIn,
                        fee: fee,
                        sqrtPriceLimitX96: 0
                    };
                    const res1 = await quoter.callStatic.quoteExactInputSingle(params1);
                    const wbnbOut = ethers.utils.formatUnits(res1.amountOut, 18);

                    if (parseFloat(wbnbOut) > 0) {
                        const params2 = {
                            tokenIn: WBNB_TOKEN,
                            tokenOut: USDT_TOKEN,
                            amountIn: ethers.utils.parseUnits(wbnbOut, 18),
                            fee: 500,
                            sqrtPriceLimitX96: 0
                        };
                        const res2 = await quoter.callStatic.quoteExactInputSingle(params2);
                        foundRate = parseFloat(ethers.utils.formatUnits(res2.amountOut, 18));
                        break;
                    }
                } catch (e) { /* try next fee */ }
            }
        }

        if (mySeq !== rateFetchSeq) return false; // stale

        if (foundRate > 0 && isFinite(foundRate)) {
            liveRate = foundRate;
            rateReady = true;
            isFallbackRate = false;
            return true;
        }

        throw new Error('No pool found');

    } catch (err) {
        console.warn('Pancake rate fetch failed, using fallback:', err);

        // Firebase fallback rate
        try {
            const snap = await get(ref(db, 'settings/rate'));
            const val = snap.exists() ? Number(snap.val()) : 0;
            if (mySeq !== rateFetchSeq) return false;
            liveRate = (isFinite(val) && val > 0) ? val : 0.95;
            rateReady = true;
            isFallbackRate = true;
            return true;
        } catch (fbErr) {
            if (mySeq !== rateFetchSeq) return false;
            liveRate = 0.95;
            rateReady = true;
            isFallbackRate = true;
            return true;
        }
    }
}

// ============================================================
// UI RENDER
// ============================================================
function refreshButtonState() {
    const btn = $('swapBtn');
    if (!btn) return;

    if (swapInProgress) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Swapping...';
        return;
    }

    if (rateLocked) {
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-lock-fill me-2"></i>Confirming...';
        return;
    }

    btn.disabled = !(rateReady && walletReady && isConnected);
    btn.innerHTML = '<i class="bi bi-arrow-left-right me-2"></i>Swap Now';
}

function updateRatePreview() {
    const amountInput = $('swapAmount');
    const raw = amountInput ? amountInput.value : '';
    const check = validateAmount(raw);

    // Rate display
    if (rateReady) {
        setText('liveRate', '$' + liveRate.toFixed(4));

        // Fallback warning badge
        const warnEl = $('rateWarning');
        if (warnEl) {
            warnEl.style.display = isFallbackRate ? 'block' : 'none';
            warnEl.textContent = isFallbackRate ? '⚠️ Estimated rate (live unavailable)' : '';
        }
    } else {
        setText('liveRate', '--');
    }

    // Receive preview
    if (check.ok && rateReady) {
        const receive = roundTo(check.amount * liveRate, 2);
        setText('youReceive', fmtUsdt(receive));
    } else {
        setText('youReceive', '--');
    }

    // Error
    const errEl = $('swapError');
    if (errEl) {
        errEl.textContent = check.error || '';
        errEl.style.display = check.error ? 'block' : 'none';
    }
}

function renderWallets(data) {
    setText('rndWalletValue', fmtRnd(data.rndWallet));
    setText('depositWalletValue', fmtUsdt(data.depositWallet));
    setText('referralWalletValue', fmtUsdt(data.referralWallet));
}

// ============================================================
// LOAD WALLETS (with real-time listener)
// ============================================================
async function loadWallets() {
    try {
        const snap = await get(ref(db, 'users/' + currentUserId));
        if (!snap.exists()) {
            showToast('❌ User data not found', 'error');
            return false;
        }
        const data = snap.val();
        rndBalance = Number(data.rndWallet || 0);
        walletReady = true;
        renderWallets(data);
        return true;
    } catch (err) {
        console.error('Load wallet error:', err);
        showToast('❌ Failed to load wallet', 'error');
        return false;
    }
}

function setupBalanceListener(uid) {
    if (balanceListenerOff) { balanceListenerOff(); balanceListenerOff = null; }
    balanceListenerOff = onValue(ref(db, 'users/' + uid), (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val();
        rndBalance = Number(data.rndWallet || 0);
        renderWallets(data);
    }, (err) => console.error('Balance listener error:', err));
}

// ============================================================
// 🚀 HANDLE SWAP — Rate Lock on Click
// ============================================================
async function handleSwap() {
    // Guard: already in progress
    if (swapInProgress || rateLocked) {
        return showToast('⏳ Swap already in progress...', 'error');
    }

    if (!currentUserId) return showToast('❌ Please login again', 'error');
    if (!isOnline()) return showToast('❌ No internet connection.', 'error');
    if (!rateReady || !walletReady) return showToast('❌ Data not loaded yet.', 'error');

    const toWallet = $('toWallet') ? $('toWallet').value : '';
    if (toWallet !== 'depositWallet' && toWallet !== 'referralWallet') {
        return showToast('❌ Invalid destination wallet', 'error');
    }

    const raw = $('swapAmount') ? $('swapAmount').value : '';
    const check = validateAmount(raw);
    if (!check.ok) return showToast('❌ ' + (check.error || 'Enter a valid amount'), 'error');
    const amount = check.amount;

    // ============================================================
    // 🔒 STEP 1: LOCK RATE IMMEDIATELY (before any await)
    // ============================================================
    rateLocked = true;
    lockedRate = liveRate;
    lockedAmount = amount;
    lockedDestWallet = toWallet;
    lockedUsdtPreview = roundTo(amount * lockedRate, 2);

    // Disable button INSTANTLY
    const btn = $('swapBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-lock-fill me-2"></i>Confirming...';
    }

    if (lockedUsdtPreview <= 0) {
        // Unlock
        rateLocked = false;
        lockedRate = 0;
        refreshButtonState();
        return showToast('❌ Amount too small', 'error');
    }

    // ============================================================
    // STEP 2: Confirm with user (rate is now frozen)
    // ============================================================
    const confirmMsg =
        `🔄 Confirm Swap\n\n` +
        `📤 You send: ${lockedAmount.toFixed(4)} RND\n` +
        `📥 You receive: ${lockedUsdtPreview.toFixed(2)} USDT\n` +
        `💱 Rate: $${lockedRate.toFixed(4)} per RND` +
        (isFallbackRate ? `\n\n⚠️ Estimated rate (live unavailable)` : '') +
        `\n\n(This rate is locked. It will not change during swap.)`;

    if (!window.confirm(confirmMsg)) {
        // User cancelled → unlock
        rateLocked = false;
        lockedRate = 0;
        refreshButtonState();
        updateRatePreview();
        return;
    }

    // ============================================================
    // STEP 3: Execute swap with LOCKED rate (no retry, no re-fetch)
    // ============================================================
    swapInProgress = true;
    refreshButtonState();

    try {
        const userRef = ref(db, 'users/' + currentUserId);
        const txId = generateTxId();
        const today = getTodayDate();
        const now = Date.now();
        let abortReason = null;

        // 🔒 Use captured lockedAmount, lockedRate, lockedDestWallet, lockedUsdtPreview
        const result = await runTransaction(userRef, (data) => {
            abortReason = null;
            if (data === null) return data;
            if (data.banned === true) { abortReason = 'banned'; return; }

            const rndNow = roundTo(Number(data.rndWallet) || 0, 8);
            if (!isFinite(rndNow) || rndNow < lockedAmount) {
                abortReason = 'insufficient';
                return;
            }

            const destNow = roundTo(Number(data[lockedDestWallet]) || 0, 2);
            data.rndWallet = roundTo(rndNow - lockedAmount, 8);
            data[lockedDestWallet] = roundTo(destNow + lockedUsdtPreview, 2);

            const transactions = data.transactions || {};
            transactions[txId] = {
                type: 'swap',
                from: 'rndWallet',
                to: lockedDestWallet,
                amount: lockedUsdtPreview,
                amountIn: lockedAmount,
                currencyIn: 'RND',
                amountOut: lockedUsdtPreview,
                currencyOut: DEST_CURRENCY,
                liveRate: lockedRate,
                swapRate: lockedRate,
                rateLocked: true,
                rateSource: isFallbackRate ? 'fallback' : 'pancakeswap',
                timestamp: now,
                date: today,
                status: 'completed',
                txId: txId,
                description: `Swapped ${lockedAmount.toFixed(4)} RND → ${lockedUsdtPreview.toFixed(2)} USDT at $${lockedRate.toFixed(4)}`
            };
            data.transactions = transactions;
            return data;
        });

        // ============================================================
        // Handle result
        // ============================================================
        if (!result.committed) {
            if (abortReason === 'banned') {
                showToast('❌ Account banned.', 'error');
                setTimeout(() => window.location.href = 'login.html', 1500);
            } else if (abortReason === 'insufficient') {
                showToast('❌ Insufficient RND balance', 'error');
                await loadWallets();
                updateRatePreview();
            } else {
                showToast('❌ Swap cancelled.', 'error');
            }
            return;
        }

        // ✅ SUCCESS
        const finalData = result.snapshot.val();
        rndBalance = Number(finalData.rndWallet || 0);
        renderWallets(finalData);

        showToast(
            `✅ Swapped ${lockedAmount.toFixed(4)} RND → ${lockedUsdtPreview.toFixed(2)} USDT`,
            'success'
        );

        // Clear input
        if ($('swapAmount')) $('swapAmount').value = '';
        updateRatePreview();

        // ✅ Unlock rate for next swap
        rateLocked = false;
        lockedRate = 0;
        lockedAmount = 0;
        lockedDestWallet = null;
        lockedUsdtPreview = 0;

    } catch (err) {
        console.error('Swap error:', err);
        showToast('❌ Swap failed. Please try again.', 'error');
    } finally {
        swapInProgress = false;
        rateLocked = false;
        lockedRate = 0;
        lockedAmount = 0;
        lockedDestWallet = null;
        lockedUsdtPreview = 0;
        refreshButtonState();
    }
}
window.handleSwap = handleSwap;

// ============================================================
// UI INIT
// ============================================================
function initUI() {
    if (uiInitialized) return;
    uiInitialized = true;

    const amountEl = $('swapAmount');
    const walletEl = $('toWallet');
    const btnEl = $('swapBtn');

    if (amountEl) amountEl.addEventListener('input', updateRatePreview);
    if (walletEl) walletEl.addEventListener('change', updateRatePreview);
    if (btnEl) btnEl.addEventListener('click', handleSwap);

    // Background rate refresh (UI only — lockedRate safe)
    const refreshRate = async () => {
        if (swapInProgress || rateLocked) return; // 🔒 Rate locked हो तो refresh मत करो
        await fetchLiveRate();
        refreshButtonState();
        updateRatePreview();
    };

    rateTimer = setInterval(refreshRate, RATE_REFRESH_MS);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !rateLocked) refreshRate();
    });

    // Connection status
    onValue(ref(db, '.info/connected'), (snap) => {
        isConnected = snap.val() === true;
        refreshButtonState();
    });

    // Online/offline
    window.addEventListener('online', () => { isConnected = true; refreshButtonState(); });
    window.addEventListener('offline', () => { isConnected = false; refreshButtonState(); });
}

// ============================================================
// AUTH GUARD + INIT
// ============================================================
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    currentUserId = user.uid;

    try {
        const snap = await get(ref(db, 'users/' + user.uid));
        if (snap.exists() && snap.val().banned === true) {
            alert('Banned.');
            window.location.href = 'login.html';
            return;
        }

        const [rateOk, walletOk] = await Promise.all([fetchLiveRate(), loadWallets()]);
        if (!rateOk) showToast('❌ Swap rate unavailable.', 'error');
        if (!walletOk) showToast('❌ Could not load wallet.', 'error');

        // Real-time balance listener
        setupBalanceListener(user.uid);

    } catch (err) {
        console.error('Init error:', err);
        showToast('❌ Error loading.', 'error');
    }

    $('loadingState')?.classList.add('hidden');
    $('swapFormCard')?.classList.remove('hidden');
    initUI();
    updateRatePreview();
    refreshButtonState();
});

// ============================================================
// CLEANUP
// ============================================================
window.addEventListener('beforeunload', () => {
    if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
    if (balanceListenerOff) { balanceListenerOff(); balanceListenerOff = null; }
});

// ============================================================
// Back button refresh (improved)
// ============================================================
document.querySelector('a[href="dashboard.html"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.replace('dashboard.html');
});

// ✅ pageshow — सिर्फ back/forward पर reload, normal load पर नहीं
window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
        window.location.reload();
    }
});
