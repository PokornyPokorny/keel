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
  'cents': () => assert.equal(R.cents(byId(both().txns, 'a-woo-5')), -3420),
};

let passed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); passed++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', String(e.message).split('\n')[0]); }
}
console.log(`money-rules-test: ${passed}/${Object.keys(cases).length} passed`);
process.exitCode = passed === Object.keys(cases).length ? 0 : 1;
