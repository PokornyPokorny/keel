// Money rules, ported from the desktop dashboard (up_dash.py) so both agree to the cent.
// Pure functions: no DOM, no storage, no network. Days are the phone's local days (never a sliced string).
import { dayKey } from './days.js';

export const cents = t => Number(t.attributes.amount.valueInBaseUnits);
const when = t => new Date(t.attributes.createdAt);
const accountOf = t => t.relationships?.account?.data?.id ?? null;
const localMidnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayGap = (a, b) => Math.round((localMidnight(when(b)) - localMidnight(when(a))) / 864e5);

// Each person's pull -> accounts and transactions, each id once. A JOINT account belongs to 'joint';
// a transaction in a joint account, or seen by both tokens, is 'joint'; otherwise it is whose token saw it.
export function stamp(pulls) {
  const accounts = new Map(), txns = new Map();
  for (const { who, accounts: accs, transactions } of pulls) {
    for (const a of accs) if (!accounts.has(a.id)) accounts.set(a.id, { ...a, owner: a.attributes.ownershipType === 'JOINT' ? 'joint' : who });
    for (const t of transactions) {
      if (txns.has(t.id)) txns.get(t.id).owner = 'joint';
      else txns.set(t.id, { ...t, owner: who });
    }
  }
  const joint = new Set([...accounts.values()].filter(a => a.owner === 'joint').map(a => a.id));
  for (const t of txns.values()) { if (joint.has(accountOf(t))) t.owner = 'joint'; delete t.pair; }
  return { accounts: [...accounts.values()], txns: [...txns.values()].sort((a, b) => when(b) - when(a)) };
}

// Money one person sent the other: link the payment (naming the payee's surname) with the matching deposit
// on the other side, within 3 days. Sets t.pair on both. Mirrors up_dash.pair_between.
export const PAIR_DAYS = 3;
export function pairBetween(txns, people) {
  const other = { me: 'partner', partner: 'me' };
  const surname = k => (people?.[k]?.surname || '').trim().toLowerCase();
  const isPurchase = t => (t.attributes.transactionType || '').includes('Purchase');
  for (const t of txns) delete t.pair;          // idempotent: re-pairing starts clean
  const ins = txns.filter(t => (t.owner === 'me' || t.owner === 'partner') && t.attributes.isCategorizable && cents(t) > 0 && !isPurchase(t));
  for (const t of [...txns].sort((a, b) => when(a) - when(b))) {
    const o = other[t.owner];
    if (!o || !surname(o) || !t.attributes.isCategorizable || cents(t) >= 0 || isPurchase(t)
        || !(t.attributes.description || '').toLowerCase().includes(surname(o))) continue;
    const cands = ins.filter(u => u.owner === o && cents(u) === -cents(t) && u.pair === undefined && Math.abs(dayGap(t, u)) <= PAIR_DAYS);
    if (!cands.length) continue;
    const u = cands.reduce((best, c) => Math.abs(dayGap(t, c)) < Math.abs(dayGap(t, best)) ? c : best);
    t.pair = u.id; u.pair = t.id;
  }
  return txns;
}

// spend | income | internal. Mirrors up_dash.split: interest is new money; own-account transfers and
// money between the two people never left, so they are internal.
export function classify(t) {
  if (t.attributes.transactionType === 'Interest') return 'income';
  if (!t.attributes.isCategorizable || t.pair !== undefined) return 'internal';
  return cents(t) < 0 ? 'spend' : 'income';
}

// "Round Up" deposits that landed in an account that still exists (up_dash.live_roundups).
export const liveRoundups = (txns, accountIds) =>
  txns.filter(t => t.attributes.description === 'Round Up' && cents(t) > 0 && accountIds.has(accountOf(t)));

const balanceOf = a => Number(a.attributes.balance.valueInBaseUnits ?? Math.round(parseFloat(a.attributes.balance.value) * 100));
const roundUpOf = t => { const a = t.attributes.roundUp?.amount; return a ? Number(a.valueInBaseUnits ?? Math.round(parseFloat(a.value) * 100)) : 0; };

// Each account's balance at a moment: today's balance with every later transaction taken back out.
// A purchase's round-up leaves the same account inside the purchase, so it comes back too
// (up_dash.balance_history; without it the rewind drifts).
export function balanceAt(accounts, txns, at) {
  const bal = Object.fromEntries(accounts.map(a => [a.id, balanceOf(a)]));
  for (const t of txns) {
    const id = accountOf(t);
    if (id in bal && when(t) > at) bal[id] -= cents(t) + roundUpOf(t);
  }
  return bal;
}

// Whose money each 2Up account holds: {accountId: {me, partner, unknown}} in cents (floats).
// Replays the joint accounts oldest first (deposits before withdrawals at the same instant), one pot per
// person, then scales to the real balance. Mirrors up_dash.joint_split.
export function jointSplit(txns, accounts, people, until = null) {
  const ownerOf = Object.fromEntries(accounts.map(a => [a.id, a.owner]));
  const pots = Object.fromEntries(accounts.filter(a => a.owner === 'joint').map(a => [a.id, {}]));
  const sum = pot => Object.values(pot).reduce((a, b) => a + b, 0);
  const share = (pot, v) => { const s = sum(pot); return s > 0 ? Object.fromEntries(Object.entries(pot).map(([w, x]) => [w, v * x / s])) : { unknown: v }; };
  const add = (pot, part) => { for (const [w, x] of Object.entries(part)) pot[w] = (pot[w] || 0) + x; };
  const list = txns.filter(t => !until || when(t) <= until)
    .sort((a, b) => (when(a) - when(b)) || ((cents(a) < 0) - (cents(b) < 0)));
  for (const t of list) {
    const pot = pots[accountOf(t)];
    if (!pot) continue;
    const v = cents(t);
    if (v < 0) {
      const s = sum(pot), keep = s > 0 ? Math.max(1 + v / s, 0) : 1;
      for (const w in pot) pot[w] *= keep;
      continue;
    }
    const src = t.relationships?.transferAccount?.data?.id ?? null;
    if (ownerOf[src] === 'me' || ownerOf[src] === 'partner') add(pot, { [ownerOf[src]]: v });
    else if (src && pots[src]) add(pot, share(pots[src], v));
    else {
      // no account to match: an outside payment naming who sent it, or interest and gifts (in proportion)
      const by = (t.attributes.performingCustomer?.displayName || '').toLowerCase();
      const who = ['me', 'partner'].find(k => people?.[k]?.surname && by.includes(people[k].surname.trim().toLowerCase()));
      add(pot, who ? { [who]: v } : share(pot, v));
    }
  }
  const bal = until ? balanceAt(accounts, txns, until) : Object.fromEntries(accounts.map(a => [a.id, balanceOf(a)]));
  const out = {};
  for (const [id, pot] of Object.entries(pots)) {
    const pos = Object.fromEntries(Object.entries(pot).filter(([, x]) => x > 0)), s = sum(pos);
    out[id] = s > 0 ? Object.fromEntries(Object.entries(pos).map(([w, x]) => [w, bal[id] * x / s])) : bal[id] ? { unknown: bal[id] } : {};
  }
  return out;
}

// The Savers panel for a view ('all' | 'me' | 'partner' | 'joint'), as at `at`, with this month's change.
export function savers(accounts, txns, view, monthStart, at) {
  const list = accounts.filter(a => a.attributes.accountType === 'SAVER' && (view === 'all' || a.owner === view));
  const now = balanceAt(accounts, txns, at), start = balanceAt(accounts, txns, monthStart);
  const rows = list.map(a => ({
    id: a.id, name: a.attributes.displayName, owner: a.owner, kind: a.owner === 'joint' ? '2Up saver' : 'Saver',
    balance: now[a.id], monthDelta: now[a.id] - start[a.id],
  })).sort((a, b) => b.balance - a.balance);
  const total = rows.reduce((s, r) => s + r.balance, 0);
  for (const r of rows) r.share = total > 0 ? r.balance / total : 0;
  const byOwner = { me: 0, partner: 0, joint: 0 };
  for (const r of rows) byOwner[r.owner] += r.balance;
  const ids = new Set(list.map(a => a.id));
  const roundupsThisMonth = liveRoundups(txns, ids).filter(t => when(t) >= monthStart && when(t) <= at).reduce((s, t) => s + cents(t), 0);
  return { total, byOwner, rows, savedThisMonth: rows.reduce((s, r) => s + r.monthDelta, 0), roundupsThisMonth };
}

export { dayKey };
