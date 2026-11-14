// Money, in headless Edge against a fake Up API: sync (S) and screens (U).
// usage: node tests/money-test.mjs [local]   — "local" serves the working tree in place of the live site.
import assert from 'node:assert/strict';
import { launch } from './harness.mjs';
import { fixture, TOKENS, PEOPLE, NOW } from './fixtures/up-fixture.mjs';

const local = process.argv[2] === 'local';
let passed = 0, total = 0;
async function check(id, fn) {
  total++;
  try { await fn(); passed++; console.log('PASS', id); }
  catch (e) { console.log('FAIL', id, '-', String(e.message).split('\n')[0]); }
}
const F = fixture();
// Page code with up.js (u), money-store.js (s) and money-rules.js (r) loaded.
const inPage = (H, body) => H.eval(`(async () => {
  const u = await import('./up.js'), s = await import('./money-store.js'), r = await import('./money-rules.js');
  const TOKENS = ${JSON.stringify(TOKENS)}, PEOPLE = ${JSON.stringify(PEOPLE)};
  ${body}
})()`);
async function fresh() {
  const H = await launch({ local });
  H.up.load(F); H.up.tokens = { ...TOKENS };
  await H.setClock(NOW); await H.open(); await H.signIn();
  return H;
}
const txCalls = H => H.up.calls.filter(c => c.startsWith('GET transactions'));

async function sync() {
  const H = await fresh();
  await check('S1 first sync pulls everything for both people; joint kept once', async () => {
    const r = await inPage(H, `const st = await u.sync({ tokens: TOKENS });
      const d = await s.load(); const all = r.stamp([{ who: 'me', ...d.pulls.me }, { who: 'partner', ...d.pulls.partner }]);
      return { st: st.status, me: d.pulls.me.transactions.length, partner: d.pulls.partner.transactions.length, stamped: all.txns.length, cats: d.categories.length }`);
    assert.deepEqual(r.st, { me: 'ok', partner: 'ok' });
    assert.equal(r.me, F.me.transactions.length + F.joint.transactions.length);
    assert.equal(r.partner, F.partner.transactions.length + F.joint.transactions.length);
    assert.equal(r.stamped, F.me.transactions.length + F.partner.transactions.length + F.joint.transactions.length);
    assert.equal(r.cats, F.categories.length);
    assert.ok(txCalls(H).every(c => !c.includes('filter')), 'full pulls have no filter');
  });
  await check('S2 next sync asks only for the last 14 days before the newest, and stores new ones', async () => {
    const t = structuredClone(F.me.transactions.find(t => t.id === 'a-woo-4'));
    t.id = 'a-new'; t.attributes.createdAt = '2026-11-14T11:30:00+10:00';
    H.up.add('me', t);
    H.up.calls.length = 0;
    const r = await inPage(H, `await u.sync({ tokens: TOKENS }); const d = await s.load(); return d.pulls.me.transactions.some(t => t.id === 'a-new')`);
    assert.equal(r, true);
    const me = txCalls(H).find(c => c.endsWith(' me'));
    assert.ok(me && decodeURIComponent(me).includes('filter[since]=2026-10-31T00:00:00.000Z'), me);
  });
  await check('S3 eight days later: a full re-pull', async () => {
    await H.setClock('2026-11-22T12:00:00'); await H.reload(); await H.signIn();
    H.up.calls.length = 0;
    await inPage(H, `await u.sync({ tokens: TOKENS })`);
    assert.ok(txCalls(H).length >= 2 && txCalls(H).every(c => !c.includes('filter')), txCalls(H).join(' | '));
  });
  await check('S4 a 429 waits for Retry-After, then succeeds', async () => {
    H.up.rateLimitNext = 1;
    const r = await inPage(H, `const t0 = performance.now(); const st = await u.sync({ tokens: TOKENS }); return { st: st.status, ms: performance.now() - t0 }`);
    assert.deepEqual(r.st, { me: 'ok', partner: 'ok' });
    assert.ok(r.ms >= 1000, `waited ${r.ms} ms`);
  });
  await check('S5 a pending transaction that settles with a new id and amount: only the settled one is kept', async () => {
    const held = F.me.transactions.find(t => t.id === 'a-uber-held');
    const settled = structuredClone(held);
    settled.id = 'a-uber-settled'; settled.attributes.status = 'SETTLED'; settled.attributes.amount.valueInBaseUnits = -1920; settled.attributes.amount.value = '-19.20';
    H.up.replace('me', 'a-uber-held', settled);
    const r = await inPage(H, `await u.sync({ tokens: TOKENS }); const d = await s.load(); const ids = d.pulls.me.transactions.map(t => t.id);
      return { held: ids.includes('a-uber-held'), settled: ids.includes('a-uber-settled') }`);
    assert.deepEqual(r, { held: false, settled: true });
  });
  await check('S6 one revoked token: that person is rejected, the other syncs, stored data stays', async () => {
    H.up.tokens.partner = 'revoked';
    const r = await inPage(H, `const st = await u.sync({ tokens: TOKENS }); const d = await s.load(); return { st: st.status, partner: d.pulls.partner.transactions.length }`);
    H.up.tokens.partner = TOKENS.partner;
    assert.deepEqual(r.st, { me: 'ok', partner: 'rejected' });
    assert.ok(r.partner > 0);
  });
  await check('S7 offline: nothing changes, updatedAt stays', async () => {
    const before = await inPage(H, `return (await s.load()).meta.updatedAt`);
    H.up.offline = true;
    const r = await inPage(H, `const st = await u.sync({ tokens: TOKENS }); const d = await s.load(); return { st: st.status, updatedAt: st.updatedAt, stored: d.meta.updatedAt, n: d.pulls.me.transactions.length }`);
    H.up.offline = false;
    assert.deepEqual(r.st, { me: 'offline', partner: 'offline' });
    assert.equal(r.updatedAt, before); assert.equal(r.stored, before);
    assert.ok(r.n > 0);
  });
  H.close();
}

// ONLY=sync,screens runs just those sections (for debugging); the gates always run everything.
const only = process.env.ONLY?.split(',');
const sections = { sync };
for (const [name, fn] of Object.entries(sections)) if (!only || only.includes(name)) await fn();
console.log(`money-test: ${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
