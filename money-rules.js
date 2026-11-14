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

export { dayKey };
