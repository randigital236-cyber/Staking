// ============================================================
// ADMIN SIDE: Reject withdrawal + automatic refund (atomic, no double refund)
// Paste into your admin panel JS and call rejectWithdrawal(adminKey)
// from the existing "Reject" button, where adminKey = key under /withdrawals/.
// Needs: import { ref, get, update, runTransaction, increment } from "firebase/database";
// ============================================================
const r8 = (v) => Math.round((Number(v) + Number.EPSILON) * 1e8) / 1e8;

export async function rejectWithdrawal(db, adminKey) {
    const wRef = ref(db, `withdrawals/${adminKey}`);

    // Step 1: claim (pending -> rejecting). Only ONE admin click/tab can win.
    // A stuck 'rejecting' (crash) can be retried after 2 minutes.
    const claim = await runTransaction(ref(db, `withdrawals/${adminKey}/status`), (cur) => {
        if (cur === null) return cur;                 // local cache empty: SDK re-runs with real value
        if (cur === 'pending' || cur === 'rejecting') return 'rejecting';
        return;                                       // approved / rejected already -> abort
    });
    if (!claim.committed || claim.snapshot.val() !== 'rejecting') {
        throw new Error('This withdrawal is already processed.');
    }

    // Step 2: read the request
    const w = (await get(wRef)).val();
    if (!w || !w.uid || !w.walletType || !(Number(w.amount) > 0)) {
        throw new Error('Invalid withdrawal record.');
    }
    if (w.walletType !== 'referralWallet' && w.walletType !== 'rndWallet') {
        throw new Error('Unknown wallet type.');
    }
    if (w.refunded === true) return true;             // safety: never refund twice

    // Step 3: ONE atomic update: refund + status in all places (all-or-nothing)
    const amt = r8(w.amount);
    const now = Date.now();
    const updates = {
        [`users/${w.uid}/${w.walletType}`]: increment(amt),          // server-side add, no stale value
        [`withdrawals/${adminKey}/status`]: 'rejected',
        [`withdrawals/${adminKey}/refunded`]: true,
        [`withdrawals/${adminKey}/refundedAt`]: now,
        [`withdrawals/${adminKey}/rejectedAt`]: now
    };
    if (w.withdrawalId) {
        updates[`users/${w.uid}/transactions/${w.withdrawalId}/status`] = 'rejected';
        updates[`users/${w.uid}/transactions/${w.withdrawalId}/refunded`] = true;
        updates[`users/${w.uid}/transactions/${w.withdrawalId}/refundedAt`] = now;
    }
    await update(ref(db), updates);
    return true;
}

// APPROVE: use the same guard so a rejected request can never be approved later
export async function approveWithdrawal(db, adminKey) {
    const claim = await runTransaction(ref(db, `withdrawals/${adminKey}/status`), (cur) => {
        if (cur === null) return cur;
        return cur === 'pending' ? 'approved' : undefined;
    });
    if (!claim.committed || claim.snapshot.val() !== 'approved') {
        throw new Error('This withdrawal is already processed.');
    }
    const w = (await get(ref(db, `withdrawals/${adminKey}`))).val();
    const updates = { [`withdrawals/${adminKey}/approvedAt`]: Date.now() };
    if (w && w.uid && w.withdrawalId) {
        updates[`users/${w.uid}/transactions/${w.withdrawalId}/status`] = 'approved';
    }
    await update(ref(db), updates);
    return true;
}
