/* =========================================================
   RND Staking - Login Logic
   Firebase Auth + Realtime Database
   ========================================================= */

import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from "firebase/auth";
import { getDatabase, ref, get } from "firebase/database";

/* ---------- Firebase Config ---------- */
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

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getDatabase(app);

/* ---------- DOM Elements ---------- */
const loginForm         = document.getElementById('loginForm');
const loginEmail        = document.getElementById('loginEmail');
const loginPassword     = document.getElementById('loginPassword');
const loginBtn          = document.getElementById('loginBtn');
const togglePassword    = document.getElementById('togglePassword');
const forgotPasswordLink= document.getElementById('forgotPasswordLink');
const toastContainer    = document.getElementById('toastContainer');

/* =========================================================
   Toast Helper
   ========================================================= */
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast-custom ${type}`;
  const icon = type === 'success'
    ? 'bi-check-circle-fill text-success'
    : 'bi-exclamation-triangle-fill text-danger';
  toast.innerHTML = `<i class="bi ${icon}"></i><span class="toast-msg"></span>`;
  toast.querySelector('.toast-msg').textContent = message; // safe text
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

/* =========================================================
   Password Visibility Toggle
   ========================================================= */
togglePassword.addEventListener('click', () => {
  const isPassword = loginPassword.type === 'password';
  loginPassword.type = isPassword ? 'text' : 'password';
  togglePassword.innerHTML = isPassword
    ? '<i class="bi bi-eye-slash"></i>'
    : '<i class="bi bi-eye"></i>';
  togglePassword.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
});

/* =========================================================
   Auth State Listener
   (redirects already-logged-in users, blocks banned users)
   ========================================================= */
onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  try {
    const snapshot = await get(ref(db, 'users/' + user.uid));

    if (snapshot.exists()) {
      const userData = snapshot.val();

      if (userData.banned) {
        showToast('Your account has been banned. Please contact support.', 'error');
        await signOut(auth);
        return;
      }

      // Valid, active user → dashboard
      window.location.href = 'dashboard.html';
    } else {
      // Auth user exists but no DB record → sign out to avoid orphan session
      console.warn('No database record found for authenticated user.');
      await signOut(auth);
      showToast('Account data not found. Please contact support.', 'error');
    }
  } catch (err) {
    console.error('Error checking user record:', err);
    showToast('Network error. Please refresh and try again.', 'error');
    // Do NOT sign out on network error - user might be valid
  }
});

/* =========================================================
   Login Form Submit
   ========================================================= */
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = loginEmail.value.trim();
  const pass  = loginPassword.value;

  if (!email || !pass) {
    showToast('Please enter both email and password.', 'error');
    return;
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Please enter a valid email address.', 'error');
    loginEmail.focus();
    return;
  }

  // Prevent double-submit
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Signing in...';

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged handles redirect
  } catch (err) {
    console.error('Login error:', err.code, err.message);

    let msg = 'Invalid email or password. Please try again.';
    switch (err.code) {
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        msg = 'Invalid email or password. Please try again.';
        break;
      case 'auth/invalid-email':
        msg = 'Please enter a valid email address.';
        break;
      case 'auth/too-many-requests':
        msg = 'Too many failed attempts. Please try again later.';
        break;
      case 'auth/network-request-failed':
        msg = 'Network error. Please check your connection.';
        break;
      case 'auth/user-disabled':
        msg = 'This account has been disabled. Please contact support.';
        break;
      default:
        msg = err.message || 'Login failed. Please try again.';
    }
    showToast(msg, 'error');
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = '<span class="btn-text">Sign In <i class="bi bi-arrow-right"></i></span>';
  }
});

/* =========================================================
   Forgot Password
   ========================================================= */
forgotPasswordLink.addEventListener('click', async (e) => {
  e.preventDefault();

  const email = prompt('Enter your email address to receive a password reset link:');
  if (!email) return;

  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    showToast('Please enter a valid email address.', 'error');
    return;
  }

  try {
    await sendPasswordResetEmail(auth, trimmed);
    showToast(`Password reset link sent to ${trimmed}`, 'success');
  } catch (err) {
    console.error('Reset error:', err.code, err.message);
    let msg = 'Failed to send reset email. Please try again.';
    if (err.code === 'auth/user-not-found') {
      msg = 'No account found with this email.';
    } else if (err.code === 'auth/invalid-email') {
      msg = 'Please enter a valid email address.';
    } else if (err.code === 'auth/too-many-requests') {
      msg = 'Too many requests. Please try again later.';
    }
    showToast(msg, 'error');
  }
});