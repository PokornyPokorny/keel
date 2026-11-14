// Headless Edge over CDP for Keel's browser tests: virtual Face ID, fake camera, a controllable clock,
// and an in-memory fake of the GitHub Contents API for PokornyPokorny/keel-data.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

export const SITE = 'https://pokornypokorny.github.io/keel/';
const API = 'https://api.github.com/repos/PokornyPokorny/keel-data';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const b64 = buf => Buffer.from(buf).toString('base64');
export const gitSha = bytes => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');

// Fake GitHub Contents API. Fields are public so tests can seed files, swap the token, or fail one PUT.
class FakeGitHub {
  files = new Map();   // path -> { bytes, sha }
  commits = [];        // { path, message }
  calls = [];          // 'METHOD url Authorization'
  token = 'github_pat_good';
  failNextPut = null;  // status to answer on the next PUT, after storing the file anyway (a lost response)
  offline = false;
  seed(path, bytes) { this.files.set(path, { bytes, sha: gitSha(bytes) }); }

  // -> { status, headers?, body?: Buffer|string } or 'offline'
  handle(method, url, headers, body) {
    if (method === 'OPTIONS') return { status: 204 };
    if (this.offline) return 'offline';
    const auth = headers.Authorization || headers.authorization || '';
    this.calls.push(`${method} ${url} ${auth}`);
    if (auth !== 'Bearer ' + this.token) return json(401, { message: 'Bad credentials' });
    const rest = decodeURIComponent(new URL(url).pathname.slice(new URL(API).pathname.length));
    if (rest === '' || rest === '/') return method === 'GET' ? json(200, { private: true, full_name: 'PokornyPokorny/keel-data' }) : json(405, {});
    if (!rest.startsWith('/contents/')) return json(404, { message: 'Not Found' });
    const path = rest.slice('/contents/'.length).replace(/\/$/, '');
    const accept = headers.Accept || headers.accept || '';

    if (method === 'PUT') {
      const req = JSON.parse(body || '{}');
      const existing = this.files.get(path);
      if (existing && req.sha !== existing.sha) return json(422, { message: existing && !req.sha ? 'Invalid request.\n\n"sha" wasn\'t supplied.' : 'sha does not match' });
      this.seed(path, Buffer.from(req.content, 'base64'));
      this.commits.push({ path, message: req.message });
      if (this.failNextPut) { const s = this.failNextPut; this.failNextPut = null; return json(s, { message: 'Server Error' }); }
      return json(existing ? 200 : 201, { content: { path, sha: this.files.get(path).sha } });
    }
    if (method !== 'GET') return json(405, {});

    const file = this.files.get(path);
    if (file) {
      if (accept.includes('raw')) return { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: file.bytes };
      return json(200, { type: 'file', name: path.split('/').pop(), path, sha: file.sha, size: file.bytes.length, encoding: 'base64', content: b64(file.bytes) });
    }
    const prefix = path + '/', kids = new Map();
    for (const [p, f] of this.files) if (p.startsWith(prefix)) {
      const name = p.slice(prefix.length).split('/')[0], isFile = !p.slice(prefix.length).includes('/');
      kids.set(name, { name, path: prefix + name, sha: isFile ? f.sha : '', type: isFile ? 'file' : 'dir' });
    }
    return kids.size ? json(200, [...kids.values()]) : json(404, { message: 'Not Found' });
  }
}
const json = (status, obj) => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

export async function launch({ local = false, camera = 'granted' } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'keel-edge-'));
  const args = ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run'];
  if (camera === 'granted') args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
  if (camera === 'denied') args.push('--use-fake-device-for-media-stream'); // real prompt, which headless dismisses -> NotAllowedError
  const edge = spawn(EDGE, [...args, 'about:blank']);

  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(100);
    const f = join(profile, 'DevToolsActivePort');
    try { port = readFileSync(f, 'utf8').split('\n')[0].trim() || undefined; } catch {} // missing, or Edge is still writing it
  }
  let tabs;
  for (let i = 0; i < 50 && !tabs?.length; i++) { tabs = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => null); if (!tabs?.length) await wait(100); }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

  const github = new FakeGitHub();
  let id = 0; const pending = {};
  const send = (method, params = {}) => new Promise((ok, bad) => {
    pending[++id] = m => m.error ? bad(new Error(`${method}: ${m.error.message}`)) : ok(m.result);
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.onmessage = async e => {
    const m = JSON.parse(e.data);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; return; }
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request, networkId } = m.params;
    try {
      if (request.url.startsWith(API)) {
        let body = request.postData;
        if (body === undefined && request.postDataEntries) body = Buffer.concat(request.postDataEntries.map(x => Buffer.from(x.bytes || '', 'base64'))).toString();
        if (body === undefined && request.hasPostData) body = (await send('Network.getRequestPostData', { requestId: networkId })).postData;
        const r = github.handle(request.method, request.url, request.headers, body);
        if (r === 'offline') return send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, accept, content-type', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
        const headers = Object.entries({ ...cors, ...(r.headers || {}) }).map(([name, value]) => ({ name, value }));
        return send('Fetch.fulfillRequest', { requestId, responseCode: r.status, responseHeaders: headers, body: b64(r.body ?? '') });
      }
      if (local && request.url.startsWith(SITE)) {
        const rel = new URL(request.url).pathname.slice(new URL(SITE).pathname.length) || 'index.html';
        if (!rel.includes('..') && existsSync(rel)) {
          return send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: b64(readFileSync(rel)),
            responseHeaders: [{ name: 'Content-Type', value: TYPES[extname(rel)] || 'application/octet-stream' }, { name: 'Cache-Control', value: 'no-store' }] });
        }
        return send('Fetch.fulfillRequest', { requestId, responseCode: 404, responseHeaders: [], body: '' });
      }
      return send('Fetch.continueRequest', { requestId });
    } catch (err) { console.error('harness:', err.message); }
  };

  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: API + '*' }, { urlPattern: SITE + '*' }] });
  // Headless Edge always has a built-in fake camera, so "no camera" is simulated on the test side.
  if (camera === 'none') await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));` });

  let clockScript = null;
  const H = {
    github, send, wait,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(expression, timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await H.eval(expression).catch(() => false)) return true; await wait(100); }
      return false;
    },
    async open(path = '') {
      await send('Page.navigate', { url: SITE + path });
      await H.waitFor(`document.readyState === 'complete'`, 10000);
      await wait(300);
    },
    async reload() { await H.open('?r=' + Date.now()); },
    // From the next navigation on, Date starts at isoLocal (local time) and keeps ticking.
    async setClock(isoLocal) {
      if (clockScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockScript });
      clockScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const Real = Date, base = new Real(${JSON.stringify(isoLocal)}).getTime(), start = performance.now();
        let extra = 0;
        const now = () => base + (performance.now() - start) + extra;
        class FakeDate extends Real { constructor(...a) { a.length ? super(...a) : super(now()); } static now() { return now(); } }
        window.Date = FakeDate;
        Object.defineProperty(window, '__keelAdvanceClock', { value: ms => { extra += ms; } });
      })();` })).identifier;
    },
    advanceClock: ms => H.eval(`__keelAdvanceClock(${ms})`),
    setOffline(on) { github.offline = on; },
    async addFaceId() {
      await send('WebAuthn.enable');
      return (await send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })).authenticatorId;
    },
    // Paste the code, skip Face ID, end on #app.
    async signIn(token = github.token) {
      await H.waitFor(`!document.getElementById('token').hidden || !document.getElementById('app').hidden`);
      if (await H.eval(`!document.getElementById('token').hidden`)) {
        await H.eval(`(()=>{document.querySelector('#token input').value=${JSON.stringify(token)}; document.getElementById('token').requestSubmit();})()`);
        await H.waitFor(`!document.getElementById('setup').hidden || !document.getElementById('app').hidden`);
        if (await H.eval(`!document.getElementById('setup').hidden`)) await H.eval(`document.getElementById('setup-skip').click()`);
      }
      return H.waitFor(`!document.getElementById('app').hidden`);
    },
    close() { try { ws.close(); edge.kill(); } catch {} setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1000); },
  };
  return H;
}

// Width, height and whether an EXIF block exists, read from JPEG markers.
export function jpegInfo(bytes) {
  let i = 2, width = 0, height = 0, hasExif = false;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1], len = bytes.readUInt16BE(i + 2);
    if (marker === 0xe1 && bytes.toString('latin1', i + 4, i + 8) === 'Exif') hasExif = true;
    if (marker === 0xc0 || marker === 0xc2) { height = bytes.readUInt16BE(i + 5); width = bytes.readUInt16BE(i + 7); break; }
    i += 2 + len;
  }
  return { width, height, hasExif };
}

// A distinct labelled JPEG drawn in the page, for seeding months.
export async function makeJpeg(H, label) {
  const data = await H.eval(`(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = 'hsl(' + (${JSON.stringify(label)}.length * 37 % 360) + ',40%,30%)'; g.fillRect(0, 0, 600, 800);
    g.fillStyle = '#fff'; g.font = '60px sans-serif'; g.fillText(${JSON.stringify(label)}, 40, 400);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1]; })()`);
  return Buffer.from(data, 'base64');
}
