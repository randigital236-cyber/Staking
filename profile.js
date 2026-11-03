import { initializeApp } from "firebase/app";
import { 
    getAuth, onAuthStateChanged, signOut, updateProfile, updateEmail, 
    sendEmailVerification, reauthenticateWithCredential, EmailAuthProvider 
} from "firebase/auth";
import { getDatabase, ref, get, update } from "firebase/database";

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

console.log('🔥 Firebase initialized successfully!');

// Toast System
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

// Sidebar Controls
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

// Logout
document.getElementById('logoutBtnSidebar').addEventListener('click', async (e) => {
    e.preventDefault();
    await signOut(auth);
    window.location.href = 'login.html';
});

// Get User Data
async function getUserData(uid) {
    const snap = await get(ref(db, 'users/' + uid));
    return snap.exists() ? snap.val() : null;
}

// Main Auth Logic
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    try {
        const userData = await getUserData(user.uid);
        if (!userData) {
            window.location.href = 'dashboard.html';
            return;
        }

        const username = userData.username || userData.referralCode || 'USER';
        const name = userData.name || 'User';
        const email = userData.email || user.email || 'No email';
        const referralCode = userData.referralCode || 'N/A';
        const rank = userData.rank || 'Member';
        const joinedDate = userData.createdAt ? new Date(userData.createdAt).toLocaleDateString('hi-IN') : 'N/A';
        const totalReferrals = userData.totalReferrals || 0;
        const totalStake = userData.totalStake || 0;
        const totalReward = userData.totalReward || 0;

        // Update sidebar
        document.getElementById('sidebarName').textContent = name;
        document.getElementById('sidebarUserId').textContent = 'ID: ' + username;
        document.getElementById('sidebarAvatar').textContent = username.charAt(0).toUpperCase();
        
        const badge = document.getElementById('referralBadge');
        if (badge) badge.textContent = totalReferrals;

        const avatarLetter = name.charAt(0).toUpperCase();

        // Render Profile UI
        document.getElementById('profileContent').innerHTML = `
            <div class="row g-4">
                <div class="col-12">
                    <h4 class="fw-bold"><i class="bi bi-person text-success me-2"></i>My Profile</h4>
                    <hr class="border-secondary" style="opacity:0.2;">
                </div>

                <!-- Profile Avatar & Basic Info -->
                <div class="col-lg-4">
                    <div class="card-glass text-center">
                        <div class="profile-avatar">${avatarLetter}</div>
                        <h5 class="fw-bold">${name}</h5>
                        <p class="text-muted small"><i class="bi bi-person-badge me-1"></i> ${username}</p>
                        <span class="rank-badge-custom">
                            <i class="bi bi-award"></i> ${rank}
                        </span>
                        <div class="mt-4 d-flex justify-content-center gap-4">
                            <div>
                                <div class="text-success fw-bold" style="font-size:1.2rem;">${totalReferrals}</div>
                                <small class="text-muted" style="font-size:0.7rem;">Referrals</small>
                            </div>
                            <div>
                                <div class="text-success fw-bold" style="font-size:1.2rem;">$${totalStake}</div>
                                <small class="text-muted" style="font-size:0.7rem;">Total Stake</small>
                            </div>
                            <div>
                                <div class="text-success fw-bold" style="font-size:1.2rem;">$${totalReward}</div>
                                <small class="text-muted" style="font-size:0.7rem;">Total Reward</small>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Edit Profile Form -->
                <div class="col-lg-8">
                    <div class="card-glass">
                        <div class="card-title"><i class="bi bi-pencil-square"></i>Edit Profile</div>
                        
                        <form id="profileForm">
                            <!-- Name - EDITABLE -->
                            <div class="mb-3">
                                <label class="form-label">
                                    Full Name 
                                    <span class="editable-badge"><i class="bi bi-pencil"></i> Editable</span>
                                </label>
                                <input type="text" id="profileName" class="form-control form-control-custom" 
                                       value="${name}" placeholder="Enter your full name" required>
                                <small class="text-muted" style="font-size:0.7rem;">
                                    <i class="bi bi-info-circle"></i> You can change your name anytime
                                </small>
                            </div>

                            <!-- Email - EDITABLE -->
                            <div class="mb-3">
                                <label class="form-label">
                                    Email Address 
                                    <span class="editable-badge"><i class="bi bi-pencil"></i> Editable</span>
                                </label>
                                <input type="email" id="profileEmail" class="form-control form-control-custom" 
                                       value="${email}" placeholder="Enter your email" required>
                                <small class="text-muted" style="font-size:0.7rem;">
                                    <i class="bi bi-info-circle"></i> You can change your email. A verification link will be sent.
                                </small>
                            </div>

                            <!-- Username - READONLY -->
                            <div class="mb-3">
                                <label class="form-label">
                                    Username / User ID 
                                    <span class="readonly-badge"><i class="bi bi-lock"></i> Read Only</span>
                                </label>
                                <input type="text" id="profileUsername" class="form-control form-control-custom" 
                                       value="${username}" disabled>
                            </div>

                            <!-- Referral Code - READONLY -->
                            <div class="mb-3">
                                <label class="form-label">
                                    Referral Code 
                                    <span class="readonly-badge"><i class="bi bi-lock"></i> Read Only</span>
                                </label>
                                <input type="text" id="profileReferral" class="form-control form-control-custom" 
                                       value="${referralCode}" disabled>
                            </div>

                            <!-- Rank - READONLY -->
                            <div class="mb-3">
                                <label class="form-label">
                                    Rank / Level 
                                    <span class="readonly-badge"><i class="bi bi-lock"></i> Read Only</span>
                                </label>
                                <input type="text" id="profileRank" class="form-control form-control-custom" 
                                       value="${rank}" disabled>
                            </div>

                            <!-- Joined Date - READONLY -->
                            <div class="mb-3">
                                <label class="form-label">
                                    Joined Date 
                                    <span class="readonly-badge"><i class="bi bi-lock"></i> Read Only</span>
                                </label>
                                <input type="text" id="profileJoined" class="form-control form-control-custom" 
                                       value="${joinedDate}" disabled>
                            </div>

                            <!-- Password Field for Email Change -->
                            <div class="mb-3" id="passwordField" style="display:none;">
                                <label class="form-label">
                                    Current Password <span class="required">*</span>
                                    <span style="font-size:0.65rem;background:rgba(239,68,68,0.12);color:#f87171;padding:2px 10px;border-radius:20px;font-weight:600;margin-left:6px;">
                                        Required for Email Change
                                    </span>
                                </label>
                                <input type="password" id="profilePassword" class="form-control form-control-custom" 
                                       placeholder="Enter your current password to change email">
                            </div>

                            <button type="submit" class="btn-primary-custom" id="saveProfileBtn">
                                <i class="bi bi-save"></i> Save Changes
                            </button>
                        </form>

                        <div class="mt-3">
                            <a href="dashboard.html" class="btn-outline-custom">
                                <i class="bi bi-arrow-left"></i> Back to Dashboard
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Show Password Field when Email Changes
        const emailInput = document.getElementById('profileEmail');
        const passwordField = document.getElementById('passwordField');
        const originalEmail = email;

        emailInput.addEventListener('input', function() {
            if (this.value.trim() !== originalEmail) {
                passwordField.style.display = 'block';
            } else {
                passwordField.style.display = 'none';
                document.getElementById('profilePassword').value = '';
            }
        });

        // Form Submit
        document.getElementById('profileForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newName = document.getElementById('profileName').value.trim();
            const newEmail = document.getElementById('profileEmail').value.trim();
            const password = document.getElementById('profilePassword').value;
            const saveBtn = document.getElementById('saveProfileBtn');

            if (!newName || newName.length < 2) {
                showToast('❌ Please enter a valid name (at least 2 characters)', 'error');
                return;
            }

            if (!newEmail || !newEmail.includes('@')) {
                showToast('❌ Please enter a valid email address', 'error');
                return;
            }

            saveBtn.disabled = true;
            saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Saving...';

            try {
                const currentUser = auth.currentUser;
                let emailChanged = false;

                // Check if email is being changed
                if (newEmail !== currentUser.email) {
                    if (!password || password.length < 6) {
                        showToast('❌ Please enter your current password to change email', 'error');
                        saveBtn.disabled = false;
                        saveBtn.innerHTML = '<i class="bi bi-save"></i> Save Changes';
                        return;
                    }

                    // Re-authenticate
                    try {
                        const credential = EmailAuthProvider.credential(currentUser.email, password);
                        await reauthenticateWithCredential(currentUser, credential);
                    } catch (reAuthError) {
                        if (reAuthError.code === 'auth/wrong-password') {
                            showToast('❌ Incorrect password. Please try again.', 'error');
                        } else if (reAuthError.code === 'auth/too-many-requests') {
                            showToast('❌ Too many failed attempts. Please try again later.', 'error');
                        } else {
                            showToast('❌ Authentication failed. Please try again.', 'error');
                        }
                        saveBtn.disabled = false;
                        saveBtn.innerHTML = '<i class="bi bi-save"></i> Save Changes';
                        return;
                    }

                    // Update email
                    try {
                        await updateEmail(currentUser, newEmail);
                        await sendEmailVerification(currentUser);
                        showToast('📧 Verification email sent to ' + newEmail, 'success');
                        emailChanged = true;
                    } catch (emailError) {
                        if (emailError.code === 'auth/email-already-in-use') {
                            showToast('❌ This email is already registered with another account', 'error');
                        } else if (emailError.code === 'auth/invalid-email') {
                            showToast('❌ Invalid email address', 'error');
                        } else {
                            showToast('❌ Failed to update email: ' + (emailError.message || 'Please try again'), 'error');
                        }
                        saveBtn.disabled = false;
                        saveBtn.innerHTML = '<i class="bi bi-save"></i> Save Changes';
                        return;
                    }
                }

                // Update name
                try {
                    await updateProfile(currentUser, { displayName: newName });
                } catch (nameError) {
                    console.error('Name update error:', nameError);
                    showToast('❌ Failed to update name in profile', 'error');
                }

                // Update Database
                const updates = { name: newName };
                if (emailChanged) updates.email = newEmail;

                await update(ref(db, 'users/' + currentUser.uid), updates);
                showToast('✅ Profile updated successfully!' + (emailChanged ? ' Please verify your new email.' : ''), 'success');

                setTimeout(() => { window.location.reload(); }, 2000);

            } catch (error) {
                console.error('Profile update error:', error);
                showToast('❌ Failed to update profile: ' + (error.message || 'Please try again'), 'error');
            }

            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="bi bi-save"></i> Save Changes';
        });

    } catch (error) {
        console.error('Error loading profile:', error);
        document.getElementById('profileContent').innerHTML = `
            <div class="text-center py-5">
                <i class="bi bi-exclamation-triangle text-danger fs-1 d-block mb-3"></i>
                <h4>Error Loading Page</h4>
                <p class="text-muted">${error.message || 'Please check your internet connection.'}</p>
                <button class="btn btn-primary-custom mt-3" onclick="location.reload()">Refresh</button>
            </div>
        `;
    }
});