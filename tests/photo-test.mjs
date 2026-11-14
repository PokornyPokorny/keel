// Photo a day, in headless Edge: storage (S), home + camera (C), reveal + grid (R).
// usage: node tests/photo-test.mjs [local]   — "local" serves the working tree in place of the live site.
import assert from 'node:assert/strict';
import { launch, makeJpeg } from './harness.mjs';

const local = process.argv[2] === 'local';
let passed = 0, total = 0;
async function check(id, fn) {
  total++;
  try { await fn(); passed++; console.log('PASS', id); }
  catch (e) { console.log('FAIL', id, '-', String(e.message).split('\n')[0]); }
}
// Run page code with the photo modules loaded as g (github.js), l (local.js); `b64` turns into a Blob.
const inPage = (H, body) => H.eval(`(async () => {
  const g = await import('./github.js'), l = await import('./local.js');
  const blob = s => new Blob([Uint8Array.from(atob(s), c => c.charCodeAt(0))], { type: 'image/jpeg' });
  const token = localStorage.getItem('keel-token');
  ${body}
})()`);

async function storage() {
  const H = await launch({ local });
  await H.open(); await H.signIn();
  const jpeg = await makeJpeg(H, 'S1'), j64 = jpeg.toString('base64');
  const path = 'photos/2026/11/2026-11-14.jpg';

  await check('S1 putPhoto saves the file with one commit', async () => {
    assert.equal(await inPage(H, `return g.putPhoto(token, '2026-11-14', blob('${j64}'))`), 'saved');
    assert.ok(H.github.files.get(path)?.bytes.equals(jpeg), 'file bytes match');
    assert.equal(H.github.commits.at(-1).message, 'photo 2026-11-14');
  });
  await check('S2 a second put for the same day is refused as exists', async () => {
    assert.equal(await inPage(H, `return g.putPhoto(token, '2026-11-14', blob('${j64}'))`), 'exists');
    assert.equal(H.github.files.size, 1);
  });
  await check('S3 listMonths and listDays', async () => {
    assert.deepEqual(await inPage(H, `return g.listMonths(token)`), ['2026-11']);
    assert.deepEqual(await inPage(H, `return g.listDays(token, '2026-11')`), ['2026-11-14']);
    assert.deepEqual(await inPage(H, `return g.listDays(token, '2026-07')`), []);
  });
  await check('S4 a wrong token is unauthorized', async () => {
    assert.equal(await inPage(H, `return g.putPhoto('github_pat_bad', '2026-11-15', blob('${j64}')).then(() => 'resolved', e => e.code)`), 'unauthorized');
  });
  await check('S5 blobSha matches the git blob sha GitHub reports', async () => {
    assert.equal(await inPage(H, `return g.blobSha(blob('${j64}'))`), H.github.files.get(path).sha);
  });
  await check('S6 used days, queue and reveal position survive a reload', async () => {
    await inPage(H, `await l.markUsed('2026-11-14'); await l.enqueue('2026-11-15', blob('${j64}')); l.setRevealPos('2026-10', 4);`);
    await H.reload();
    const r = await inPage(H, `return { used: await l.isUsed('2026-11-14'), other: await l.isUsed('2026-11-13'),
      queued: await l.queuedDays(), size: (await l.queuedBlob('2026-11-15')).size, pos: l.revealPos('2026-10') }`);
    assert.deepEqual(r, { used: true, other: false, queued: ['2026-11-15'], size: jpeg.length, pos: 4 });
  });
  H.close();
}

await storage();
console.log(`photo-test: ${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
