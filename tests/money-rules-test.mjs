// Unit tests for money-rules.js against the made-up fixture. Run: node tests/money-rules-test.mjs
import assert from 'node:assert/strict';
import { fixture, PEOPLE } from './fixtures/up-fixture.mjs';
const R = await import('../money-rules.js');

const f = fixture();
const pull = (who, k) => ({ who, accounts: [...f[k].accounts, ...f.joint.accounts], transactions: [...f[k].transactions, ...f.joint.transactions] });
const both = () => { const s = R.stamp([pull('me', 'me'), pull('partner', 'partner')]); R.pairBetween(s.txns, PEOPLE); return s; };
const byId = (txns, id) => txns.find(t => t.id === id);

const cases = {
  // ---- Task 2 ----
  'stamp: joint transactions kept once, owners set': () => {
    const { accounts, txns } = both();
    assert.equal(txns.length, f.me.transactions.length + f.partner.transactions.length + f.joint.transactions.length);
    assert.equal(byId(txns, 'j-origin').owner, 'joint');
    assert.equal(byId(txns, 'a-woo-4').owner, 'me');
    assert.equal(byId(txns, 's-coles-nov').owner, 'partner');
    assert.deepEqual(Object.fromEntries(accounts.map(a => [a.id, a.owner])),
      { 'a-spend': 'me', 'a-holiday': 'me', 'a-rainy': 'me', 'j-house': 'joint', 'j-bills': 'joint', 's-spend': 'partner', 's-house': 'partner' });
  },
  'stamp: newest first': () => {
    const { txns } = both();
    assert.ok(txns.every((t, i) => i === 0 || new Date(txns[i - 1].attributes.createdAt) >= new Date(t.attributes.createdAt)));
  },
  'stamp: ported up_dump selftest (merge order and owners)': () => {
    const acct = (id, own = 'INDIVIDUAL') => ({ id, attributes: { ownershipType: own } });
    const tx = (id, when) => ({ id, attributes: { createdAt: when }, relationships: { account: { data: { id: 'x' } } } });
    const { accounts, txns } = R.stamp([
      { who: 'me', accounts: [acct('e'), acct('j', 'JOINT')], transactions: [tx('1', '2026-09-01'), tx('J', '2026-09-03')] },
      { who: 'partner', accounts: [acct('l'), acct('j', 'JOINT')], transactions: [tx('J', '2026-09-03'), tx('2', '2026-09-02')] },
    ]);
    assert.deepEqual(accounts.map(a => [a.id, a.owner]), [['e', 'me'], ['j', 'joint'], ['l', 'partner']]);
    assert.deepEqual(txns.map(t => [t.id, t.owner]), [['J', 'joint'], ['2', 'partner'], ['1', 'me']]);
  },
  'pair: a payment naming the other person pairs with their deposit a day later': () => {
    const { txns } = both();
    assert.equal(byId(txns, 'a-to-sam').pair, 's-from-alex');
    assert.equal(byId(txns, 's-from-alex').pair, 'a-to-sam');
  },
  'pair: no pair 4 days later, and none for a payment that names nobody': () => {
    const { txns } = both();
    assert.equal(byId(txns, 's-refund').pair, undefined);
    assert.equal(byId(txns, 'a-plumber').pair, undefined);
    assert.equal(byId(txns, 's-plumber-back').pair, undefined);
  },
  'pair: each deposit is used once': () => {
    const { txns } = both();
    const t2 = structuredClone(byId(txns, 'a-to-sam')); t2.id = 'a-to-sam-2';
    const all = [...txns, t2]; R.pairBetween(all, PEOPLE);
    assert.equal(all.filter(t => t.pair === 's-from-alex').length, 1);
  },
  'pair: one person only': () => {
    const s = R.stamp([pull('me', 'me')]);
    R.pairBetween(s.txns, PEOPLE);
    assert.ok(s.txns.every(t => t.pair === undefined));
  },
  'classify: interest, transfers, pairs, purchases, pay': () => {
    const { txns } = both(), c = id => R.classify(byId(txns, id));
    assert.deepEqual(['a-int-nov', 'a-hol-nov-out', 'a-to-sam', 's-from-alex', 'a-woo-4', 'a-plumber', 'a-pay-nov', 's-plumber-back', 's-refund'].map(c),
      ['income', 'internal', 'internal', 'internal', 'spend', 'spend', 'income', 'income', 'income']);
  },
  'roundups: only deposits into accounts that still exist': () => {
    const { accounts, txns } = both();
    const ids = R.liveRoundups(txns, new Set(accounts.map(a => a.id))).map(t => t.id);
    assert.deepEqual(ids, ['a-ru-1']);
  },
  'stamp: the fresher pull wins for a shared (joint) account': () => {
    const ja = c => ({ id: 'j', attributes: { ownershipType: 'JOINT', balance: { valueInBaseUnits: c } } });
    const { accounts } = R.stamp([{ who: 'me', syncedAt: '2026-11-01T00:00:00Z', accounts: [ja(100)], transactions: [] },
                                  { who: 'partner', syncedAt: '2026-11-14T00:00:00Z', accounts: [ja(200)], transactions: [] }]);
    assert.equal(accounts[0].attributes.balance.valueInBaseUnits, 200);
  },
  'cents': () => assert.equal(R.cents(byId(both().txns, 'a-woo-5')), -3420),

  // ---- Task 3 ----
  'jointSplit: ported up_dash selftest cases': () => {
    const ac = (id, c, owner) => ({ id, owner, attributes: { ownershipType: owner === 'joint' ? 'JOINT' : 'INDIVIDUAL', balance: { valueInBaseUnits: c } } });
    const jt = (acct, amt, day, src, by) => ({ attributes: { createdAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00+10:00`, amount: { valueInBaseUnits: amt },
      performingCustomer: by ? { displayName: by } : null }, relationships: { account: { data: { id: acct } }, transferAccount: { data: src ? { id: src } : null } } });
    const accs = [ac('e', 0, 'me'), ac('l', 0, 'partner'), ac('j', 400, 'joint'), ac('s', 152, 'joint'), ac('k', 100, 'joint'), ac('z', 0, 'joint')];
    const sp = R.jointSplit([jt('j', 400, 1, 'e'), jt('j', 600, 1, 'l'), jt('j', -500, 2), jt('s', 100, 3, 'j'), jt('j', -100, 3, 's'),
      jt('s', 50, 4, 'e'), jt('s', 2, 5), jt('k', 100, 5, 'gone')], accs, PEOPLE);
    const r = Object.fromEntries(Object.entries(sp).map(([k, d]) => [k, Object.fromEntries(Object.entries(d).map(([w, v]) => [w, Math.round(v * 10) / 10]))]));
    assert.deepEqual(r.j, { me: 160, partner: 240 });
    assert.deepEqual(r.s, { me: 91.2, partner: 60.8 }, '2Up money carries its own split');
    assert.deepEqual(r.k, { unknown: 100 });
    assert.deepEqual(r.z, {});
    assert.deepEqual(R.jointSplit([jt('k', 100, 5, 'gone', '$samjones')], accs, PEOPLE).k, { partner: 100 });
  },
  'jointSplit: fixture House and Bills keep the 4:7 split, summing to the balance': () => {
    const { accounts, txns } = both(), sp = R.jointSplit(txns, accounts, PEOPLE);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`);
    near(sp['j-house'].me, 50200 * 4 / 11); near(sp['j-house'].partner, 50200 * 7 / 11);
    near(sp['j-bills'].me, 2000 * 4 / 11); near(sp['j-bills'].partner, 2000 * 7 / 11);
  },
  'balanceAt: ported up_dash selftest (a round-up leaves Spending too)': () => {
    const accs = [{ id: 'e', owner: 'me', attributes: { balance: { valueInBaseUnits: 2977 } } }];
    const t = (amt, day, ru) => ({ attributes: { createdAt: `2026-09-0${day}T10:00:00+10:00`, amount: { valueInBaseUnits: amt },
      roundUp: ru ? { amount: { valueInBaseUnits: ru } } : null }, relationships: { account: { data: { id: 'e' } } } });
    const txs = [t(5000, 1), t(-2000, 2, -23)];
    assert.equal(R.balanceAt(accs, txs, new Date(2026, 8, 1, 23, 59, 59)).e, 5000);
    assert.equal(R.balanceAt(accs, txs, new Date(2026, 8, 3, 23, 59, 59)).e, 2977);
  },
  'balanceAt: fixture at the end of October': () => {
    const { accounts, txns } = both(), b = R.balanceAt(accounts, txns, new Date(2026, 10, 1));
    assert.equal(b['a-holiday'], 180000 - 312 - 10000 - 80);
    assert.equal(b['a-rainy'], 125000);
    assert.equal(b['s-house'], 360000 - 25000);
    assert.equal(b['j-house'], 50200 - 200 + 6000);
  },
  'savers: everyone': () => {
    const { accounts, txns } = both();
    const s = R.savers(accounts, txns, 'all', new Date(2026, 10, 1), new Date(2026, 10, 14, 12));
    assert.equal(s.total, 715200);
    assert.deepEqual(s.byOwner, { me: 305000, partner: 360000, joint: 50200 });
    assert.deepEqual(s.rows.map(r => [r.id, r.balance, r.monthDelta, r.kind]),
      [['s-house', 360000, 25000, 'Saver'], ['a-holiday', 180000, 10392, 'Saver'], ['a-rainy', 125000, 0, 'Saver'], ['j-house', 50200, -5800, '2Up saver']]);
    assert.equal(s.savedThisMonth, 29592);
    assert.equal(s.roundupsThisMonth, 80);
    assert.ok(Math.abs(s.rows.reduce((a, r) => a + r.share, 0) - 1) < 1e-9);
  },
  'savers: one person': () => {
    const { accounts, txns } = both();
    const s = R.savers(accounts, txns, 'partner', new Date(2026, 10, 1), new Date(2026, 10, 14, 12));
    assert.deepEqual(s.rows.map(r => r.id), ['s-house']);
    assert.equal(s.total, 360000);
  },

  // ---- Task 4 ---- (hand-worked from the fixture; NOW = 14 Nov 2026 12:00)
  'summary: everyone, November so far vs October to the same moment': () => {
    const s = R.summary(both().txns, 'all', '2026-11', NOW_D);
    assert.deepEqual([s.out, s.in, s.net, s.prevOutToSameMoment, s.prevMonth], [90559, 223512, 132953, 77699, '2026-10']);
    assert.equal(s.outByDay.length, 30);
    assert.equal(s.outByDay[6], 51000);                 // 7 Nov: rent + plumber
    assert.equal(s.prevOutByDay.length, 31);
  },
  'summary: one person excludes the others, and internal money': () => {
    const s = R.summary(both().txns, 'me', '2026-11', NOW_D);
    assert.equal(s.out, 77459);
  },
  'summary: day 1 empty': () => {
    const s = R.summary(both().txns, 'all', '2026-11', new Date(2026, 10, 1, 0, 5));
    assert.deepEqual([s.out, s.in, s.net, s.prevOutToSameMoment], [0, 0, 0, 0]);
    assert.ok(s.outByDay.every(Number.isFinite));
  },
  'summary: +11:00 at 23:30 on the last day counts in that month': () => {
    const oct = R.summary(both().txns, 'me', '2026-10', NOW_D);
    assert.ok(oct.outByDay[30] >= 2000, 'Late Pizza on 31 Oct');
    assert.equal(R.summary(both().txns, 'me', '2026-11', NOW_D).outByDay[0], 0, 'not on 1 Nov');
  },
  'categories: parents and subs, sorted, totalling the spend': () => {
    const c = R.categories(both().txns, 'all', '2026-11', f.categories, NOW_D);
    assert.deepEqual(c.map(x => [x.name, x.total]), [['Home', 73920], ['Transport', 6340], ['Good Life', 5299], ['Personal', 5000]]);
    assert.deepEqual(c[0].subs.map(x => [x.name, x.total]), [['Rent & Mortgage', 48000], ['Groceries', 18920], ['Utilities', 7000]]);
    assert.equal(c.reduce((a, x) => a + x.total, 0), 90559);
  },
  'daily: highest day and average so far': () => {
    const d = R.daily(both().txns, 'all', '2026-11', NOW_D);
    assert.deepEqual(d.highest, { day: '2026-11-07', cents: 51000 });
    assert.equal(d.average, Math.round(90559 / 14));
  },
  'merchants: by count, then total': () => {
    const m = R.merchants(both().txns, 'all', '2026-11', NOW_D);
    assert.deepEqual(m[0], { name: 'Goodlife Health', count: 2, total: 5000 });
  },
  'repeats: weekly, fortnightly, monthly with next dates; ignores irregular and twice-seen': () => {
    const r = R.repeats(both().txns, 'all', NOW_D);
    assert.deepEqual(r.map(x => [x.name, x.every, x.amount, dayKey(x.next)]),
      [['Goodlife Health', 'weekly', 2500, '2026-11-17'], ['Rent Co', 'fortnightly', 48000, '2026-11-21'], ['Netflix', 'monthly', 1699, '2026-12-02']]);
    assert.equal(r[1].perMonth, Math.round(48000 * 26 / 12));
  },
};
const NOW_D = new Date(2026, 10, 14, 12, 0);
const { dayKey } = await import('../days.js');

let passed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); passed++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', String(e.message).split('\n')[0]); }
}
console.log(`money-rules-test: ${passed}/${Object.keys(cases).length} passed`);
process.exitCode = passed === Object.keys(cases).length ? 0 : 1;
