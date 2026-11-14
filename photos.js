// Photo a day: home, the one-shot camera, the upload queue, and the monthly reveal + grid.
// Lives inside #app once Keel is unlocked.
import { dayKey, monthOf, monthLabel, shortDate, daysInMonth, isUnlocked, monthGrid, pendingReveals } from './days.js';
import * as gh from './github.js';
import * as local from './local.js';

const BLOCKED = "Camera blocked. Allow camera access for Keel, then try again. Today isn't used.";
const NO_CAMERA = "No camera found. Today isn't used.";
const STORAGE = "Keel couldn't read its storage on this phone. Close Keel and open it again.";
const MAX_SIDE = 1500;
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const plural = n => `${n} ${n === 1 ? 'day' : 'days'}`;

export function startPhotos({ root, getToken, onUnauthorized }) {
  root.innerHTML = `
    <div id="photos-home" class="layer scroll" hidden>
      <div class="ph-top"><button type="button" class="plain" id="photos-back">‹ Money</button></div>
      <section class="home">
        <p id="today"></p>
        <button id="open-camera" hidden>Open camera · one shot</button>
        <p id="message" role="status"></p>
        <p id="month-line"></p>
        <nav id="months" aria-label="Past months"></nav>
      </section>
    </div>
    <div id="camera" class="layer" hidden>
      <video playsinline muted autoplay></video>
      <div class="camera-bar">
        <button class="flip" aria-label="Flip camera">Flip</button>
        <button class="shutter" aria-label="Take photo" disabled></button>
      </div>
    </div>
    <div id="reveal" class="layer" hidden>
      <p class="reveal-wait" hidden>Waiting for signal</p>
      <p class="reveal-label"></p>
    </div>
    <div id="grid" class="layer scroll" hidden>
      <header><button class="back plain">Back</button><h2 class="grid-title"></h2></header>
      <div class="grid-head">${WEEKDAYS.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="grid-days"></div>
    </div>
    <div id="viewer" class="layer" hidden></div>`;
  const $ = s => root.querySelector(s);
  const todayEl = $('#today'), openBtn = $('#open-camera'), message = $('#message'), monthLine = $('#month-line'), monthsNav = $('#months');
  const layer = $('#camera'), video = $('video'), shutter = $('.shutter'), flipBtn = $('.flip');
  const revealEl = $('#reveal'), revealLabel = $('.reveal-label'), revealWait = $('.reveal-wait');
  const gridEl = $('#grid'), gridTitle = $('.grid-title'), gridDays = $('.grid-days'), viewer = $('#viewer');

  let cam = null;               // { stream, day, facing } while the camera is open
  let starting = false;         // opening the camera is in progress (ignores a second tap)
  let rv = null;                // reveal in progress: { months: [{month, days}], m, i, loading, waiting }
  let renderedDay = null, renderSeq = 0, flushing = null, months = [];
  const held = new Map();       // day -> Blob the phone's storage refused; uploaded straight from memory

  // ---- what exists: GitHub's listing (or the last one saved on this phone) plus photos not yet uploaded ----
  async function loadMonths(token, now, network) {
    const unauthorized = e => { if (e.code === 'unauthorized') throw e; };
    let names = local.savedMonths();
    if (network) {
      try { names = await gh.listMonths(token); local.saveMonths(names); }
      catch (e) { unauthorized(e); }
    }
    const pending = [...await local.queuedDays(), ...held.keys()];
    const all = [...new Set([...names, ...pending.map(monthOf), monthOf(dayKey(now))])].sort();
    return Promise.all(all.map(async month => {
      let days = local.savedDays(month);
      if (network) {
        try { days = await gh.listDays(token, month); local.saveDays(month, days); }
        catch (e) { unauthorized(e); }
      }
      return { month, days: [...new Set([...days, ...pending.filter(d => monthOf(d) === month)])].sort() };
    }));
  }

  // ---- home: paint from what the phone knows at once, then again once GitHub answers ----
  async function renderHome() {
    const seq = ++renderSeq, token = getToken();
    if (!token) return;
    let loaded;
    for (const network of [false, true]) {
      const now = new Date();
      let state;
      try {
        const next = await loadMonths(token, now, network);
        state = [next, await local.dayState(dayKey(now))];
      } catch (e) {
        if (e.code === 'unauthorized') return onUnauthorized();
        if (seq === renderSeq) message.textContent = STORAGE;
        return;
      }
      if (seq !== renderSeq) return;
      loaded = state[0];
      paint(now, ...state);
    }
    return loaded;
  }

  function paint(now, loaded, todayState) {
    const today = dayKey(now), month = monthOf(today);
    months = loaded;
    const current = months.find(m => m.month === month)?.days ?? [];
    // 'taken' is recorded on the phone, so a GitHub listing that lags the upload can't make it look missed.
    const taken = current.includes(today) || todayState === 'taken';
    renderedDay = today;
    todayEl.textContent = taken ? "Today's done" : todayState ? 'No photo today' : '';
    openBtn.hidden = taken || !!todayState || !!cam;
    monthLine.textContent = `${monthLabel(month, now)} · ${plural(current.length)}`;
    if (message.textContent === STORAGE) message.textContent = '';
    const notice = local.takeNotice();
    if (notice) message.textContent = notice;
    monthsNav.replaceChildren(...months.filter(m => m.days.length && isUnlocked(m.month, now)).reverse().map(m => {
      const b = document.createElement('button');
      b.className = 'month-row plain';
      b.textContent = `${monthLabel(m.month, now)} · ${m.days.length} of ${daysInMonth(m.month)} days`;
      b.addEventListener('click', () => local.revealPos(m.month) === 'done' ? openGrid(m) : startReveal([m]));
      return b;
    }));
  }

  // ---- uploads: photos held in memory first, then the phone's queue ----
  const flushQueue = () => flushing ??= doFlush().catch(() => {}).finally(() => { flushing = null; });
  async function doFlush() {
    const token = getToken();
    if (!token) return;
    let queued = [];
    try { queued = await local.queuedDays(); } catch {} // storage trouble: still try what's held in memory
    for (const day of [...held.keys(), ...queued]) {
      const fromMemory = held.has(day);
      try {
        const blob = fromMemory ? held.get(day) : await local.queuedBlob(day);
        if (await gh.putPhoto(token, day, blob) === 'exists') {
          // Either our own earlier upload whose reply was lost, or another phone got there first.
          const [mine, theirs] = await Promise.all([gh.blobSha(blob), gh.remoteSha(token, day)]);
          if (theirs === null) continue;            // refused, yet nothing there: keep it and try again later
          if (mine !== theirs) local.setNotice(`Another phone already saved ${shortDate(day)}. The photo from this phone was dropped.`);
        }
        if (fromMemory) held.delete(day); else await local.dequeue(day);
        local.markTaken(day).catch(() => {});
      } catch (e) {
        if (e.code === 'unauthorized') { onUnauthorized(); return; }
        if (e.code === 'offline' || e.code === 'http') return; // the queue stays for next time
      }
    }
  }

  // ---- camera ----
  async function getStream(facing) {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('No camera API', 'NotFoundError');
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false });
  }
  const stopTracks = stream => stream?.getTracks().forEach(t => t.stop());
  const playing = () => new Promise(ok => {
    if (video.readyState >= 2 && !video.paused) return ok();
    video.addEventListener('playing', ok, { once: true });
    video.play().catch(() => {});
  });
  async function showStream(stream, facing) {
    video.srcObject = stream;
    video.classList.toggle('mirror', facing === 'user');
    await playing();
  }

  async function openCamera() {
    if (cam || starting) return;                   // a second tap while the camera starts does nothing
    starting = true;
    try {
      message.textContent = '';
      const day = dayKey(new Date());
      let stream;
      try { stream = await getStream('environment'); }
      catch (e) { message.textContent = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? BLOCKED : NO_CAMERA; return; }
      cam = { stream, day, facing: 'environment' };
      openBtn.hidden = true;
      await showStream(stream, 'environment');
      if (cam?.stream !== stream) return;          // left the app before the picture appeared: not counted
      try { await local.markUsed(day); }           // the attempt counts from here, before the picture shows
      catch (e) {
        closeCamera();
        message.textContent = `Couldn't open the camera: ${e.message} Today isn't used.`;
        openBtn.hidden = false;
        return;
      }
      if (cam?.stream !== stream) return renderHome();
      layer.hidden = false;
      shutter.disabled = false;
    } finally { starting = false; }
  }

  async function flip() {
    if (!cam) return;
    const c = cam, to = c.facing === 'environment' ? 'user' : 'environment';
    shutter.disabled = true;
    stopTracks(c.stream);
    let stream = await getStream(to).catch(() => null), facing = to;
    if (!stream) { stream = await getStream(c.facing).catch(() => null); facing = c.facing; }
    if (cam !== c) return stopTracks(stream);      // closed while switching
    if (!stream) { closeCamera(); message.textContent = 'The camera stopped working.'; return renderHome(); } // today is already used
    c.stream = stream; c.facing = facing;
    await showStream(stream, facing);
    if (cam === c) shutter.disabled = false;
  }

  function closeCamera() {
    if (!cam) return;
    stopTracks(cam.stream);
    cam = null;
    video.srcObject = null;
    layer.hidden = true;
    shutter.disabled = true;
  }

  async function shoot() {
    if (!cam || shutter.disabled) return;
    shutter.disabled = true;
    const { day } = cam;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height); // unmirrored, even for the front camera
    closeCamera();
    await save(day, canvas);
    await renderHome();
    await flushQueue();
    await renderHome();
    if (held.has(day)) message.textContent = "Today's photo hasn't uploaded yet. Keep Keel open until it does.";
  }

  // A captured shot is never thrown away for a technical fault. If this phone's storage won't take it,
  // it is held in memory and uploaded straight from there.
  async function save(day, canvas) {
    let blob, last;
    for (let attempt = 0; attempt < 3 && !blob; attempt++) {
      try { blob = await new Promise((ok, bad) => canvas.toBlob(b => b ? ok(b) : bad(new Error('the photo could not be encoded')), 'image/jpeg', 0.85)); }
      catch (e) { last = e; await new Promise(r => setTimeout(r, 1000)); }
    }
    if (!blob) { message.textContent = `Couldn't save today's photo: ${last?.message || last}`; return false; }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await local.enqueue(day, blob);
        await local.markTaken(day).catch(() => {});
        return true;
      } catch (e) { last = e; await new Promise(r => setTimeout(r, 1000)); }
    }
    held.set(day, blob);
    return true;
  }

  // ---- photos of unlocked months: phone first, then GitHub ----
  async function photoBlob(day) {
    const cached = await local.cacheGet(day) ?? await local.queuedBlob(day);
    if (cached) return cached;
    const blob = await gh.getPhoto(getToken(), day);
    await local.cachePut(day, blob);
    return blob;
  }
  const urls = new Set();
  const objectUrl = blob => { const u = URL.createObjectURL(blob); urls.add(u); return u; };
  const revokeAll = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); };

  // ---- reveal: once per month, oldest first, resumes where it stopped ----
  function startReveal(list) {
    const m = list[0], pos = local.revealPos(m.month);
    rv = { months: list, m: 0, i: typeof pos === 'number' ? Math.min(pos, m.days.length - 1) : 0, loading: false, waiting: false };
    gridEl.hidden = true;
    revealEl.hidden = false;
    showRevealPhoto();
  }

  async function showRevealPhoto() {
    const r = rv, { month, days } = r.months[r.m], i = r.i, day = days[i];
    revealLabel.textContent = `${shortDate(day)} · ${i + 1}/${days.length}`;
    local.setRevealPos(month, i);
    // Until this photo is on screen, taps don't move on: a photo is never skipped in the once-only reveal.
    r.loading = true; r.waiting = false;
    revealWait.hidden = true;
    revealEl.querySelector('img')?.remove();
    let blob;
    try { blob = await photoBlob(day); }
    catch (e) {
      if (e.code === 'unauthorized') { closeReveal(); return onUnauthorized(); }
      if (rv === r && r.i === i) { r.loading = false; r.waiting = true; revealWait.hidden = false; }
      return;
    }
    if (rv !== r || r.i !== i || r.months[r.m].month !== month) return; // moved on meanwhile
    r.loading = false;
    const img = document.createElement('img');
    img.alt = shortDate(day);
    img.src = objectUrl(blob);
    revealEl.prepend(img);
    for (const next of days.slice(i + 1, i + 3)) photoBlob(next).catch(() => {}); // preload
  }

  function revealNext() {
    if (!rv || rv.loading) return;              // never move past a photo that hasn't been seen
    if (rv.waiting) return showRevealPhoto();   // "Waiting for signal": a tap tries again
    const { month, days } = rv.months[rv.m];
    if (rv.i < days.length - 1) { rv.i++; return showRevealPhoto(); }
    local.setRevealPos(month, 'done');
    if (rv.m < rv.months.length - 1) { rv.m++; rv.i = Math.max(0, Number(local.revealPos(rv.months[rv.m].month)) || 0); return showRevealPhoto(); }
    const last = rv.months[rv.m];
    closeReveal();
    openGrid(last);
  }
  function revealBack() {
    if (!rv || rv.i === 0) return;
    rv.i--;
    showRevealPhoto();
  }
  function closeReveal() {
    rv = null;
    revealEl.hidden = true;
    revealWait.hidden = true;
    revealEl.querySelector('img')?.remove();
    revokeAll();
  }

  let downX = null;
  revealEl.addEventListener('pointerdown', e => { downX = e.clientX; });
  revealEl.addEventListener('pointerup', e => {
    if (downX === null) return;
    const dx = e.clientX - downX; downX = null;
    if (dx > 50) revealBack(); else if (Math.abs(dx) < 15) revealNext();
  });
  document.addEventListener('keydown', e => {
    if (revealEl.hidden) return;
    if (e.key === 'ArrowLeft') revealBack();
    else if (e.key === 'ArrowRight' || e.key === ' ') revealNext();
  });

  // ---- grid ----
  function openGrid({ month, days }) {
    const now = new Date();
    revokeAll();
    gridTitle.textContent = `${monthLabel(month, now)} · ${days.length} of ${daysInMonth(month)} days`;
    gridDays.replaceChildren(...monthGrid(month).flat().map(day => {
      if (!day) { const c = document.createElement('div'); c.className = 'cell blank'; return c; }
      if (!days.includes(day)) {
        const c = document.createElement('div');
        c.className = 'cell missed';
        c.textContent = Number(day.slice(8));
        return c;
      }
      const c = document.createElement('button');
      c.className = 'cell photo';
      c.setAttribute('aria-label', shortDate(day));
      const img = document.createElement('img');
      img.alt = '';
      c.append(img);
      photoBlob(day).then(b => { img.src = objectUrl(b); }, () => { c.dataset.day = Number(day.slice(8)); });
      c.addEventListener('click', () => openViewer(day));
      return c;
    }));
    gridEl.hidden = false;
    gridEl.scrollTop = 0;
  }
  function closeGrid() { gridEl.hidden = true; gridDays.replaceChildren(); revokeAll(); renderHome(); }

  async function openViewer(day) {
    let blob;
    try { blob = await photoBlob(day); } catch { return; }
    const img = document.createElement('img');
    img.alt = shortDate(day);
    img.src = objectUrl(blob);
    viewer.replaceChildren(img);
    viewer.hidden = false;
  }

  $('.back').addEventListener('click', closeGrid);
  viewer.addEventListener('click', () => { viewer.hidden = true; viewer.replaceChildren(); });

  // ---- wiring ----
  openBtn.addEventListener('click', openCamera);
  shutter.addEventListener('click', shoot);
  flipBtn.addEventListener('click', flip);
  // Leaving the app with the camera open loses the day (it was marked used when the picture appeared).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (cam) { closeCamera(); renderHome(); } }
    else if (!root.closest('[hidden]')) refresh(); // back in Keel (and unlocked): upload what's waiting, catch up
  });
  window.addEventListener('online', async () => {
    await flushQueue();
    if (rv?.waiting) showRevealPhoto();
    renderHome();
  });
  setInterval(() => { if (renderedDay && dayKey(new Date()) !== renderedDay && !cam) refresh(); }, 15000);

  async function refresh() {
    if (rv?.waiting) showRevealPhoto();
    await renderHome();                          // paint first: a weak signal must not leave home blank
    await flushQueue();
    const loaded = await renderHome();
    if (!loaded || rv || cam) return;
    const pending = pendingReveals(loaded, m => local.revealPos(m) === 'done', new Date());
    if (pending.length) startReveal(pending.map(m => loaded.find(x => x.month === m)));
  }
  const photosHome = $('#photos-home');
  $('#photos-back').addEventListener('click', () => { photosHome.hidden = true; });
  return {
    refresh,
    openHome() { photosHome.hidden = false; photosHome.scrollTop = 0; renderHome(); },
  };
}
