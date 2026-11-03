import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { getDatabase, ref, set, get, update } from "firebase/database";

// Firebase Config
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
// 🔥 TOAST SYSTEM
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
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}

// ============================================================
// 🔥 PASSWORD VISIBILITY TOGGLE
// ============================================================
document.getElementById('togglePassword').addEventListener('click', function() {
    const passwordInput = document.getElementById('regPassword');
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    this.innerHTML = isPassword ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
});

// ============================================================
// 🔥 GET REFERRAL CODE FROM URL
// ============================================================
let referralCodeFromURL = '';

function getReferralFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    const ref = urlParams.get('ref');
    console.log('🔍 URL Referral Code Found:', ref);
    if (ref) {
        referralCodeFromURL = ref;
        return ref;
    }
    return '';
}

// Auto-fill referral from URL
const refFromURL = getReferralFromURL();
if (refFromURL) {
    document.getElementById('regRef').value = refFromURL;
    document.getElementById('referralNoticeText').textContent = '✅ Referral code auto-filled from link!';
    document.getElementById('referralNotice').className = 'referral-notice active';
    console.log('✅ Referral code auto-filled:', refFromURL);
}

// Real-time referral input update
document.getElementById('regRef').addEventListener('input', function() {
    const val = this.value.trim();
    if (val) {
        document.getElementById('referralNoticeText').textContent = '📌 Referral code: ' + val;
        document.getElementById('referralNotice').className = 'referral-notice active';
    } else {
        document.getElementById('referralNoticeText').textContent = 'Enter referrer\'s User ID if you have one';
        document.getElementById('referralNotice').className = 'referral-notice';
    }
});

// ============================================================
// 🔥 UPDATE 5 LEVEL REFERRAL SYSTEM
// ============================================================
async function update5LevelReferral(referralCode, newUserUid, newUserName, newUserEmail) {
    try {
        console.log('🔍 ===== STARTING REFERRAL UPDATE =====');
        const allUsersSnap = await get(ref(db, 'users'));
        if (!allUsersSnap.exists()) return;
        
        const allUsers = allUsersSnap.val();
        let referrerUid = null;
        let referrerData = null;
        
        for (let key in allUsers) {
            if (allUsers[key].referralCode === referralCode) {
                referrerUid = key;
                referrerData = allUsers[key];
                break;
            }
        }
        
        if (!referrerUid) {
            console.log('❌ REFERRER NOT FOUND with code:', referralCode);
            return;
        }
        
        // Add to direct referrals (Level 1)
        const directRefs = referrerData.directReferrals || {};
        directRefs[newUserUid] = {
            uid: newUserUid,
            name: newUserName,
            email: newUserEmail,
            joinedAt: Date.now(),
            level: 1
        };
        
        const currentLevel1 = referrerData.teamStructure?.level1 || 0;
        await update(ref(db, 'users/' + referrerUid), {
            totalReferrals: (referrerData.totalReferrals || 0) + 1,
            downline: (referrerData.downline || 0) + 1,
            directReferrals: directRefs,
            'teamStructure/level1': currentLevel1 + 1
        });
        
        // --- Level 2 ---
        const level2RefCode = referrerData.referredBy;
        if (level2RefCode && level2RefCode !== '') {
            for (let key in allUsers) {
                if (allUsers[key].referralCode === level2RefCode) {
                    const l2User = allUsers[key];
                    await update(ref(db, 'users/' + key), {
                        totalReferrals: (l2User.totalReferrals || 0) + 1,
                        downline: (l2User.downline || 0) + 1,
                        'teamStructure/level2': (l2User.teamStructure?.level2 || 0) + 1
                    });
                    
                    // --- Level 3 ---
                    const level3RefCode = l2User.referredBy;
                    if (level3RefCode && level3RefCode !== '') {
                        for (let k3 in allUsers) {
                            if (allUsers[k3].referralCode === level3RefCode) {
                                const l3User = allUsers[k3];
                                await update(ref(db, 'users/' + k3), {
                                    totalReferrals: (l3User.totalReferrals || 0) + 1,
                                    downline: (l3User.downline || 0) + 1,
                                    'teamStructure/level3': (l3User.teamStructure?.level3 || 0) + 1
                                });
                                
                                // --- Level 4 ---
                                const level4RefCode = l3User.referredBy;
                                if (level4RefCode && level4RefCode !== '') {
                                    for (let k4 in allUsers) {
                                        if (allUsers[k4].referralCode === level4RefCode) {
                                            const l4User = allUsers[k4];
                                            await update(ref(db, 'users/' + k4), {
                                                totalReferrals: (l4User.totalReferrals || 0) + 1,
                                                downline: (l4User.downline || 0) + 1,
                                                'teamStructure/level4': (l4User.teamStructure?.level4 || 0) + 1
                                            });
                                            
                                            // --- Level 5 ---
                                            const level5RefCode = l4User.referredBy;
                                            if (level5RefCode && level5RefCode !== '') {
                                                for (let k5 in allUsers) {
                                                    if (allUsers[k5].referralCode === level5RefCode) {
                                                        const l5User = allUsers[k5];
                                                        await update(ref(db, 'users/' + k5), {
                                                            totalReferrals: (l5User.totalReferrals || 0) + 1,
                                                            downline: (l5User.downline || 0) + 1,
                                                            'teamStructure/level5': (l5User.teamStructure?.level5 || 0) + 1
                                                        });
                                                        break;
                                                    }
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }
                                break;
                            }
                        }
                    }
                    break;
                }
            }
        }
        console.log('✅ ===== REFERRAL SYSTEM FULLY UPDATED =====');
    } catch (error) {
        console.error('❌ Error updating referral system:', error);
    }
}

// ============================================================
// 🔥 EMAIL REGISTRATION
// ============================================================
document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const pass = document.getElementById('regPassword').value;
    const refCode = document.getElementById('regRef').value.trim();
    const registerBtn = document.getElementById('registerBtn');
    
    // Validation
    if (!name || name.length < 2) { showToast('❌ Please enter your full name', 'error'); return; }
    if (!email || !email.includes('@')) { showToast('❌ Please enter a valid email address', 'error'); return; }
    if (pass.length < 6) { showToast('❌ Password must be at least 6 characters long!', 'error'); return; }
    
    // Lock UI
    registerBtn.disabled = true;
    registerBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Creating Account...';

    try {
        // 1. Create Auth User
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        const uid = cred.user.uid;
        await updateProfile(auth.currentUser, { displayName: name });
        
        // 2. Determine Referral Code (Input > URL)
        const finalRefCode = refCode || referralCodeFromURL || '';
        
        // 3. Build User Data
        const userData = {
            uid: uid,
            username: uid,
            name: name,
            email: email,
            referralCode: uid, // User's own code is their UID
            referredBy: finalRefCode,
            rank: 'Member',
            role: 'user',
            banned: false,
            createdAt: Date.now(),
            lastActive: Date.now(),
            depositWallet: 0,
            referralWallet: 0,
            rndWallet: 0,
            lockedRND: 0,
            releaseWallet: 0,
            totalStake: 0,
            totalReward: 0,
            availableReward: 0,
            totalWithdrawn: 0,
            level1Earnings: 0,
            level2Earnings: 0,
            level3Earnings: 0,
            level4Earnings: 0,
            level5Earnings: 0,
            referralEarnings: 0,
            teamBusiness: 0,
            subscriptions: 0,
            totalReferrals: 0,
            downline: 0,
            teamStructure: { level1: 0, level2: 0, level3: 0, level4: 0, level5: 0 },
            directReferrals: {},
            packages: {},
            transferHistory: []
        };
        
        // 4. Save to Database
        await set(ref(db, 'users/' + uid), userData);
        await set(ref(db, 'usernames/' + uid), uid);

        // 5. Update Referrers
        if (finalRefCode) {
            await update5LevelReferral(finalRefCode, uid, name, email);
        }
        
        showToast('✅ Account created successfully! Welcome ' + name + '!', 'success');
        
        // Wait 2s for DB sync, then redirect
        await new Promise(resolve => setTimeout(resolve, 2000));
        window.location.href = 'dashboard.html';
        
    } catch (err) {
        console.error('❌ Registration Error:', err);
        let msg = 'Registration failed. Please try again.';
        if (err.code === 'auth/email-already-in-use') msg = '❌ This email is already registered.';
        else if (err.code === 'auth/weak-password') msg = '❌ Password must be at least 6 characters.';
        else if (err.code === 'auth/invalid-email') msg = '❌ Please enter a valid email address.';
        showToast(msg, 'error');
        
        // Reset button ONLY on error
        registerBtn.disabled = false;
        registerBtn.innerHTML = 'Create Account <i class="bi bi-arrow-right ms-1"></i>';
    }
});