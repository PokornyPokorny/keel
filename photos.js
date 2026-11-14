// Photo a day: home, the one-shot camera, the upload queue. Lives inside #app once Keel is unlocked.
import { dayKey, monthOf, monthLabel, shortDate } from './days.js';
import * as gh from './github.js';
import * as local from './local.js';

const BLOCKED = "Camera blocked. Allow camera access for Keel, then try again. Today isn't used.";
const NO_CAMERA = "No camera found. Today isn't used.";
const MAX_SIDE = 1500;

export function startPhotos({ root, getToken, onUnauthorized }) {
  root.innerHTML = `
    <section class="home">
      <p id="today"></p>
      <button id="open-camera" hidden>Open camera · one shot</button>
      <p id="message" role="status"></p>
      <p id="month-line"></p>
    </section>
    <div id="camera" class="layer" hidden>
      <video playsinline muted autoplay></video>
      <div class="camera-bar">
        <button class="flip" aria-label="Flip camera">Flip</button>
        <button class="shutter" aria-label="Take photo" disabled></button>
      </div>
    </div>`;
  const $ = s => root.querySelector(s);
  const todayEl = $('#today'), openBtn = $('#open-camera'), message = $('#message'), monthLine = $('#month-line');
  const layer = $('#camera'), video = $('video'), shutter = $('.shutter'), flipBtn = $('.flip');

  let cam = null;               // { stream, day, facing } while the camera is open
  let renderedDay = null, renderSeq = 0, flushing = null;
  const remoteDays = {};        // month -> last days GitHub listed, kept for offline renders

  // ---- home ----
  async function renderHome() {
    const seq = ++renderSeq, token = getToken();
    if (!token) return;
    const now = new Date(), today = dayKey(now), month = monthOf(today);
    try { remoteDays[month] = await gh.listDays(token, month); }
    catch (e) { if (e.code === 'unauthorized') return onUnauthorized(); } // offline: use what we last saw
    const queued = await local.queuedDays();
    const used = await local.isUsed(today);
    if (seq !== renderSeq) return;
    const days = new Set([...(remoteDays[month] || []), ...queued.filter(d => monthOf(d) === month)]);
    const taken = days.has(today);
    renderedDay = today;
    todayEl.textContent = taken ? "Today's done" : used ? 'No photo today' : '';
    openBtn.hidden = taken || used || !!cam;
    monthLine.textContent = `${monthLabel(month, now)} · ${days.size} ${days.size === 1 ? 'day' : 'days'}`;
    const notice = local.takeNotice();
    if (notice) message.textContent = notice;
  }

  // ---- upload queue ----
  const flushQueue = () => flushing ??= doFlush().finally(() => { flushing = null; });
  async function doFlush() {
    const token = getToken();
    if (!token) return;
    for (const day of await local.queuedDays()) {
      const blob = await local.queuedBlob(day);
      try {
        if (await gh.putPhoto(token, day, blob) === 'exists') {
          // Either our own earlier upload whose reply was lost, or another phone got there first.
          const [mine, theirs] = await Promise.all([gh.blobSha(blob), gh.remoteSha(token, day)]);
          if (mine !== theirs) local.setNotice(`Another phone already saved ${shortDate(day)}. The photo from this phone was dropped.`);
        }
        await local.dequeue(day);
      } catch (e) {
        if (e.code === 'unauthorized') onUnauthorized();
        return; // offline or GitHub trouble: the queue stays for next time
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
  async function show(stream, facing) {
    video.srcObject = stream;
    video.classList.toggle('mirror', facing === 'user');
    await playing();
  }

  async function openCamera() {
    if (cam) return;
    message.textContent = '';
    const day = dayKey(new Date());
    let stream;
    try { stream = await getStream('environment'); }
    catch (e) { message.textContent = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? BLOCKED : NO_CAMERA; return; }
    cam = { stream, day, facing: 'environment' };
    openBtn.hidden = true;
    await show(stream, 'environment');
    if (cam?.stream !== stream) return;            // left the app before the picture appeared: not counted
    await local.markUsed(day);                     // the attempt counts from here, before the picture shows
    if (cam?.stream !== stream) return renderHome();
    layer.hidden = false;
    shutter.disabled = false;
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
    await show(stream, facing);
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
  }

  // A captured shot is never thrown away for a technical fault: retry, then say what went wrong.
  async function save(day, canvas) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const blob = await new Promise((ok, bad) => canvas.toBlob(b => b ? ok(b) : bad(new Error('the photo could not be encoded')), 'image/jpeg', 0.85));
        await local.enqueue(day, blob);
        return true;
      } catch (e) { last = e; await new Promise(r => setTimeout(r, 1000)); }
    }
    message.textContent = `Couldn't save today's photo: ${last?.message || last}`;
    return false;
  }

  openBtn.addEventListener('click', openCamera);
  shutter.addEventListener('click', shoot);
  flipBtn.addEventListener('click', flip);
  // Leaving the app with the camera open loses the day (it was marked used when the picture appeared).
  document.addEventListener('visibilitychange', () => { if (document.hidden && cam) { closeCamera(); renderHome(); } });
  window.addEventListener('online', () => flushQueue().then(renderHome));
  setInterval(() => { if (renderedDay && dayKey(new Date()) !== renderedDay && !cam) renderHome(); }, 15000);

  return {
    async refresh() {
      await flushQueue();
      await renderHome();
    },
  };
}
