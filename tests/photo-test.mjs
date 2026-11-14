// Photo a day, in headless Edge: storage (S), home + camera (C), reveal + grid (R).
// usage: node tests/photo-test.mjs [local]   — "local" serves the working tree in place of the live site.
import assert from 'node:assert/strict';
import { launch, makeJpeg, jpegInfo } from './harness.mjs';

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
    H.setOffline(true); // since Task 4 the app uploads the queue on open; offline keeps it queued
    await H.reload();
    const r = await inPage(H, `return { used: await l.isUsed('2026-11-14'), other: await l.isUsed('2026-11-13'),
      queued: await l.queuedDays(), size: (await l.queuedBlob('2026-11-15')).size, pos: l.revealPos('2026-10') }`);
    H.setOffline(false);
    assert.deepEqual(r, { used: true, other: false, queued: ['2026-11-15'], size: jpeg.length, pos: 4 });
  });
  H.close();
}

// ---- Home + camera (Task 4) ----
const text = H => H.eval(`document.getElementById('app').innerText`);
const visible = (H, sel) => H.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none'; })()`);
const openCamera = H => H.eval(`document.getElementById('open-camera').click()`);
async function shoot(H) {
  assert.ok(await H.waitFor(`(() => { const b = document.querySelector('[aria-label="Take photo"]'); return b && !b.disabled && !b.closest('[hidden]'); })()`, 8000), 'shutter ready');
  await H.eval(`document.querySelector('[aria-label="Take photo"]').click()`);
}
const homeHas = (H, s, ms = 5000) => H.waitFor(`document.getElementById('app').innerText.includes(${JSON.stringify(s)})`, ms);
const dayOpen = async (H, iso) => { await H.setClock(iso); await H.reload(); await H.signIn(); await H.wait(500); };

async function cameraErrors() {
  let H = await launch({ local, camera: 'denied' });
  await H.setClock('2026-11-14T09:00'); await H.open(); await H.signIn();
  await check('C2 blocked camera: plain message, today not used', async () => {
    await openCamera(H);
    assert.ok(await homeHas(H, "Camera blocked. Allow camera access for Keel, then try again. Today isn't used."), await text(H));
    assert.equal(await inPage(H, `return l.isUsed('2026-11-14')`), false);
    assert.ok(await visible(H, '#open-camera'), 'open button still offered');
  });
  H.close();
  H = await launch({ local, camera: 'none' });
  await H.setClock('2026-11-14T09:00'); await H.open(); await H.signIn();
  await check('C2b no camera: plain message, today not used', async () => {
    await openCamera(H);
    assert.ok(await homeHas(H, "No camera found. Today isn't used."), await text(H));
    assert.equal(await inPage(H, `return l.isUsed('2026-11-14')`), false);
  });
  H.close();
}

async function camera() {
  const H = await launch({ local });
  await H.setClock('2026-11-14T09:00'); await H.open(); await H.signIn(); await H.wait(500);
  const file = day => H.github.files.get(`photos/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.jpg`);
  const queued = () => inPage(H, `return l.queuedDays()`);

  await check('C1 home offers one shot and counts the month', async () => {
    assert.ok(await homeHas(H, 'Open camera · one shot'), await text(H));
    assert.ok(await homeHas(H, 'November · 0 days'), await text(H));
  });
  await check('C3 opening the camera uses today; only flip + shutter; shutter waits for video', async () => {
    const disabledAtTap = await H.eval(`(() => { document.getElementById('open-camera').click();
      const b = document.querySelector('[aria-label="Take photo"]'); return !b || b.disabled; })()`);
    assert.equal(disabledAtTap, true, 'shutter disabled before playing');
    assert.ok(await H.waitFor(`!document.getElementById('camera').hidden`, 8000), 'camera visible');
    assert.equal(await inPage(H, `return l.isUsed('2026-11-14')`), true);
    assert.deepEqual(await H.eval(`[...document.querySelectorAll('#camera button')].map(b => b.getAttribute('aria-label'))`), ['Flip camera', 'Take photo']);
  });
  await check('C4 shutter saves a small, EXIF-free JPEG and shows nothing', async () => {
    await shoot(H);
    assert.ok(await homeHas(H, "Today's done"), await text(H));
    assert.ok(await H.waitFor(`document.getElementById('app').innerText.includes('November · 1 day')`, 5000), await text(H));
    assert.ok(await H.waitFor(`true`) && file('2026-11-14'), 'file uploaded');
    const info = jpegInfo(file('2026-11-14').bytes);
    assert.ok(info.width > 0 && Math.max(info.width, info.height) <= 1500, JSON.stringify(info));
    assert.equal(info.hasExif, false);
    assert.equal(await H.eval(`document.querySelectorAll('#app img').length`), 0);
  });
  await check('C5 after reload today stays done, no camera offered', async () => {
    await H.reload(); await H.signIn();
    assert.ok(await homeHas(H, "Today's done"), await text(H));
    assert.equal(await visible(H, '#open-camera'), false);
  });
  await check('C6 leaving with the camera open: day lost, camera off', async () => {
    await dayOpen(H, '2026-11-15T09:00');
    await H.eval(`window.__tracks = []; const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async c => { const s = await orig(c); __tracks.push(...s.getTracks()); return s; }`);
    await openCamera(H);
    assert.ok(await H.waitFor(`!document.getElementById('camera').hidden`, 8000), 'camera visible');
    await H.eval(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}); document.dispatchEvent(new Event('visibilitychange'))`);
    await H.wait(500);
    assert.equal(await H.eval(`__tracks.length > 0 && __tracks.every(t => t.readyState === 'ended')`), true, 'tracks stopped');
    assert.ok(await homeHas(H, 'No photo today'), await text(H));
    await H.reload(); await H.signIn();
    assert.ok(await homeHas(H, 'No photo today'), await text(H));
    assert.equal(file('2026-11-15'), undefined);
  });
  await check('C7 offline shot is queued, counts as done, uploads when back online', async () => {
    H.setOffline(true);
    await dayOpen(H, '2026-11-16T09:00');
    await openCamera(H); await shoot(H);
    assert.ok(await homeHas(H, "Today's done"), await text(H));
    assert.deepEqual(await queued(), ['2026-11-16']);
    assert.equal(file('2026-11-16'), undefined);
    H.setOffline(false);
    await H.eval(`window.dispatchEvent(new Event('online'))`);
    assert.ok(await H.waitFor(`true`) && await (async () => { for (let i = 0; i < 30 && !file('2026-11-16'); i++) await H.wait(100); return !!file('2026-11-16'); })(), 'uploaded within 3 s');
    await H.wait(300);
    assert.deepEqual(await queued(), []);
  });
  await check('C8 lost response after GitHub saved: retry recognises its own photo, no notice', async () => {
    await dayOpen(H, '2026-11-17T09:00');
    H.github.failNextPut = 502;
    await openCamera(H); await shoot(H);
    assert.ok(await homeHas(H, "Today's done"), await text(H));
    await H.wait(1500);
    assert.deepEqual(await queued(), ['2026-11-17']);
    await H.reload(); await H.signIn(); await H.wait(1500);
    assert.deepEqual(await queued(), []);
    assert.equal((await text(H)).includes('Another phone'), false);
    assert.equal(H.github.commits.filter(c => c.path.endsWith('2026-11-17.jpg')).length, 1);
  });
  await check('C9 another phone saved first: this shot dropped, told once', async () => {
    H.setOffline(true);
    await dayOpen(H, '2026-11-18T09:00');
    await openCamera(H); await shoot(H);
    assert.ok(await homeHas(H, "Today's done"));
    const other = await makeJpeg(H, 'other phone');
    H.github.seed('photos/2026/11/2026-11-18.jpg', other);
    H.setOffline(false);
    await H.reload(); await H.signIn();
    assert.ok(await homeHas(H, 'Another phone already saved 18 Nov. The photo from this phone was dropped.'), await text(H));
    assert.deepEqual(await queued(), []);
    assert.ok(file('2026-11-18').bytes.equals(other));
    await H.reload(); await H.signIn(); await H.wait(800);
    assert.equal((await text(H)).includes('Another phone'), false);
  });
  await check('C10 today already on GitHub (other phone): no camera offered', async () => {
    await H.setClock('2026-11-19T09:00');
    H.github.seed('photos/2026/11/2026-11-19.jpg', await makeJpeg(H, 'c10'));
    await H.reload(); await H.signIn();
    assert.ok(await homeHas(H, "Today's done"), await text(H));
    assert.equal(await visible(H, '#open-camera'), false);
  });
  await check('C11 rejected code: back to the code screen, queue kept, uploads after re-paste', async () => {
    H.setOffline(true);
    await dayOpen(H, '2026-11-20T09:00');
    await openCamera(H); await shoot(H);
    assert.ok(await homeHas(H, "Today's done"));
    H.github.token = 'github_pat_new';
    H.setOffline(false);
    await H.reload();
    assert.ok(await H.waitFor(`!document.getElementById('token').hidden && document.querySelector('#token .error').textContent === 'GitHub rejected the saved code.'`, 5000),
      await H.eval(`document.body.innerText`));
    assert.deepEqual(await queued(), ['2026-11-20']);
    await H.signIn('github_pat_new');
    for (let i = 0; i < 30 && !file('2026-11-20'); i++) await H.wait(100);
    assert.ok(file('2026-11-20'), 'uploaded');
    await H.wait(300);
    assert.deepEqual(await queued(), []);
  });
  await check('C12 midnight: a shot belongs to the day the camera opened; home rolls over by itself', async () => {
    await dayOpen(H, '2026-11-21T23:59:50');
    await openCamera(H);
    assert.ok(await H.waitFor(`!document.getElementById('camera').hidden`, 8000));
    await H.advanceClock(15000);                 // now past midnight, camera still open
    await shoot(H);
    for (let i = 0; i < 30 && !file('2026-11-21'); i++) await H.wait(100);
    assert.ok(file('2026-11-21'), 'saved under 21 Nov');
    assert.equal(file('2026-11-22'), undefined);
    await dayOpen(H, '2026-11-22T23:59:50');     // shoot before midnight, then let midnight pass with no interaction
    await openCamera(H); await shoot(H);
    assert.ok(await homeHas(H, "Today's done"), await text(H));
    await H.advanceClock(15000);
    assert.ok(await homeHas(H, 'Open camera · one shot', 17000), await text(H));
  });
  H.close();
}

await storage();
await cameraErrors();
await camera();
console.log(`photo-test: ${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
