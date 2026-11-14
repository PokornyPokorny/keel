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

// ---- Screens (Task 7b) ----
const mText = H => H.eval(`document.getElementById('money').innerText`);
const mHas = (H, t, ms = 6000) => H.waitFor(`document.getElementById('money').innerText.includes(${JSON.stringify(t)})`, ms);
const click = (H, sel) => H.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const setVal = (H, sel, v) => H.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const hero = H => H.eval(`document.querySelector('#money .hero .big')?.innerText.replace(/\\s/g, '') ?? ''`);
const shown = (H, sel) => H.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.closest('[hidden]'); })()`);

async function screens() {
  const H = await fresh();
  await check('U1 no tokens: plain empty state that opens Money settings', async () => {
    assert.ok(await mHas(H, 'Connect Up to see your money here.'), await mText(H));
    await click(H, '#m-connect');
    assert.ok(await shown(H, '#m-settings'), 'settings open');
  });
  await check('U2 names and tokens: a bad token is refused, good ones sync and fill Money', async () => {
    for (const [sel, v] of [['#n-me-first', 'Alex'], ['#n-me-sur', 'Smith'], ['#n-p-first', 'Sam'], ['#n-p-sur', 'Jones']]) await setVal(H, sel, v);
    await click(H, '#n-save');
    await setVal(H, '#t-me', 'up:yeah:wrong'); await click(H, '#t-me-save');
    assert.ok(await H.waitFor(`document.getElementById('t-me-msg').textContent === 'Up rejected that token.'`), 'rejected message');
    await setVal(H, '#t-me', TOKENS.me); await click(H, '#t-me-save');
    await setVal(H, '#t-partner', TOKENS.partner); await click(H, '#t-partner-save');
    assert.ok(await H.waitFor(`document.getElementById('t-me-msg').textContent === 'Connected' && document.getElementById('t-partner-msg').textContent === 'Connected'`, 8000), 'connected');
    await click(H, '#m-settings-back');
    assert.ok(await H.waitFor(`document.querySelector('#money .hero .big')?.innerText.replace(/\\s/g, '') === '905.59'`, 10000), await hero(H));
    assert.ok(await mHas(H, 'Updated just now'), 'freshness');
  });
  await check('U3 Whose: each view adds up its own money', async () => {
    const pick = async v => { await H.eval(`document.querySelector('#money .whose [data-v="${v}"]').click()`); await H.wait(150); return hero(H); };
    assert.deepEqual([await pick('me'), await pick('partner'), await pick('joint'), await pick('all')], ['774.59', '91.00', '40.00', '905.59']);
    assert.deepEqual(await H.eval(`[...document.querySelectorAll('#money .whose button')].map(b => b.textContent)`), ['All', 'Alex', 'Sam', 'Joint']);
  });
  await check('U4 savers and the 2Up split', async () => {
    assert.ok(await mHas(H, '$7,152.00'), 'savings total');
    for (const t of ['House deposit', 'Holiday', 'Rainy day', '+$103.92 this month', 'Alex $3,050.00 · Sam $3,600.00 · joint $502.00']) assert.ok((await mText(H)).includes(t), t);
    assert.ok((await mText(H)).includes('Alex $182.55') && (await mText(H)).includes('Sam $319.45'), 'House split');
  });
  await check('U5 last month: balances at its end, no Coming, closed-savers note', async () => {
    await click(H, '#money [data-act="month"][data-d="-1"]');
    assert.ok(await mHas(H, 'October 2026'), 'month title');
    const t = await mText(H);
    assert.ok(t.includes('$1,696.08'), 'Holiday at 31 Oct');
    assert.ok(!t.includes('COMING') && !t.includes('Coming'), 'no Coming');
    assert.ok(t.trim().endsWith("Closed savers aren't shown."), t.trim().slice(-120));
    await click(H, '#money [data-act="month"][data-d="1"]');
    assert.ok(await mHas(H, 'November 2026'));
  });
  await check('U6 a transaction shows everything Up knows; Receipt fetches the attachment', async () => {
    await click(H, '#money [data-tx="a-woo-5"]');
    assert.ok(await shown(H, '#m-sheet'), 'sheet open');
    const t = await H.eval(`document.getElementById('m-sheet').innerText`);
    for (const s of ['Woolworths Toowong', '−$34.20', 'Groceries', 'weekly-shop', 'card ··4821', '$0.80', 'WOOLWORTHS 4410 TOOWONG QLD AUS', 'Big shop', 'Open in Up']) assert.ok(t.includes(s), s);
    H.up.calls.length = 0;
    await click(H, '#m-receipt');
    assert.ok(await H.waitFor(`!!document.querySelector('#m-sheet a[href="https://up-attachments.example/att-1.jpg"]')`), 'receipt link');
    assert.ok(H.up.calls.some(c => c.startsWith('GET attachments/att-1')), H.up.calls.join('|'));
    await click(H, '#m-sheet-close');
  });
  await check('U7 a category chip filters the feed', async () => {
    await click(H, '#money .chip[data-cat="transport"]');
    await H.wait(150);
    const parents = await H.eval(`[...document.querySelectorAll('#money .feed [data-tx]')].map(e => e.dataset.parent)`);
    assert.ok(parents.length > 0 && parents.every(p => p === 'transport'), parents.join(','));
    await click(H, '#money .chip[data-cat=""]');
  });
  await check('U11 balance over time for a saver', async () => {
    await click(H, '#money [data-acct="a-holiday"]');
    assert.ok(await shown(H, '#m-balance'), 'balance sheet');
    const t = await H.eval(`document.getElementById('m-balance').innerText`);
    assert.ok(t.includes('Today $1,800.00') && t.includes('Start $1,696.08'), t);
    await click(H, '#m-balance-close');
  });
  await check('U15 the sheet also shows who made it, the type and a hold', async () => {
    await click(H, '#money [data-tx="j-origin"]');
    let t = await H.eval(`document.getElementById('m-sheet').innerText`);
    assert.ok(t.includes('Made by') && t.includes('Sam Jones') && t.includes('Type') && t.includes('Purchase'), t);
    await click(H, '#m-sheet-close');
    await click(H, '#money [data-tx="a-uber-held"]');
    t = await H.eval(`document.getElementById('m-sheet').innerText`);
    assert.ok(t.includes('Hold') && t.includes('$18.40'), t);
    await click(H, '#m-sheet-close');
  });
  await check('U14 small grey text is readable (contrast at least 4.5:1)', async () => {
    const cols = await H.eval(`[getComputedStyle(document.querySelector('#money .fine')).color, getComputedStyle(document.querySelector('#money .heat span[title]:not([style])')).color]`);
    assert.deepEqual(cols, ['rgb(142, 142, 147)', 'rgb(142, 142, 147)']);
  });
  await check('U12 a rejected token says so on Money and points to settings', async () => {
    H.up.tokens.me = 'regenerated';
    await H.reload(); await H.signIn();
    assert.ok(await mHas(H, "Up rejected Alex's token"), await mText(H));
    assert.ok(await H.eval(`!!document.querySelector('#money .month [data-act="settings"]')`), 'link to settings');
    H.up.tokens.me = TOKENS.me;
    await H.reload(); await H.signIn();
    assert.ok(await mHas(H, 'Updated just now'));
  });
  await check('U13 Remove during a sync stays removed', async () => {
    await click(H, '#money [data-act="settings"]');
    H.up.delayMs = 700;
    await click(H, '#m-refresh-all');
    await H.wait(200);
    await click(H, '#m-settings [data-act="remove"][data-w="partner"]');
    await H.wait(7000);
    H.up.delayMs = 0;
    const r = await inPage(H, `const d = await s.load(); return { stored: !!d.pulls.partner, token: localStorage.getItem('keel-up-token-partner') }`);
    assert.deepEqual(r, { stored: false, token: null });
    await setVal(H, '#t-partner', TOKENS.partner); await click(H, '#t-partner-save');
    assert.ok(await H.waitFor(`document.getElementById('t-partner-msg').textContent === 'Connected'`, 8000));
    await click(H, '#m-settings-back');
    assert.ok(await H.waitFor(`document.querySelector('#money .hero .big')?.innerText.replace(/\s/g, '') === '905.59'`, 15000), 'partner data back');
  });
  await check('U8 offline later: everything from the phone, says how old it is', async () => {
    H.up.offline = true;
    await H.reload(); await H.signIn();
    assert.ok(await H.waitFor(`document.querySelector('#money .hero .big')?.innerText.replace(/\\s/g, '') === '905.59'`, 8000), await hero(H));
    assert.ok(await mHas(H, 'Offline · from'), await mText(H));
    H.up.offline = false;
  });
  await check('U10 only reads from Up, nothing else', async () => {
    assert.ok(H.up.calls.length > 0 && H.up.calls.every(c => c.startsWith('GET ')), H.up.calls.filter(c => !c.startsWith('GET ')).join('|'));
  });
  await check('U9 4,000 transactions: fast first paint, feed capped with Show earlier', async () => {
    H.up.offline = true;
    await H.eval(`(async () => { const s = await import('./money-store.js'); const d = await s.load(); const base = d.pulls.me.transactions.find(t => t.id === 'a-woo-4');
      const many = Array.from({ length: 4000 }, (_, i) => { const t = structuredClone(base); t.id = 'g' + i; t.attributes.createdAt = new Date(2026, 10, 1 + (i % 13), 8, i % 60).toISOString(); return t; });
      await s.saveFull('me', d.pulls.me.accounts, [...d.pulls.me.transactions, ...many]); })()`);
    await H.reload(); await H.signIn();
    assert.ok(await H.waitFor(`(document.querySelector('#money .hero .big')?.innerText.replace(/\\s/g, '') ?? '').length > 6`, 10000), 'hero painted');
    const ms = await H.eval(`performance.now()`);
    const rows = await H.eval(`document.querySelectorAll('#money .feed [data-tx]').length`);
    H.up.offline = false;
    assert.ok(rows <= 150 && await H.eval(`!!document.querySelector('#money [data-act="earlier"]')`), `rows ${rows}`);
    assert.ok(ms < 4000, `painted by ${Math.round(ms)} ms after navigation`);
  });
  H.close();
}

// ONLY=sync,screens runs just those sections (for debugging); the gates always run everything.
const only = process.env.ONLY?.split(',');
const sections = { sync, screens };
for (const [name, fn] of Object.entries(sections)) if (!only || only.includes(name)) await fn();
console.log(`money-test: ${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
