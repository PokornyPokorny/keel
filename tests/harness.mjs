// Headless Edge over CDP for Keel's browser tests: virtual Face ID, fake camera, a controllable clock,
// and an in-memory fake of the GitHub Contents API for PokornyPokorny/keel-data.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
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
  rejectNextPut = null; // status to answer on the next PUT without storing anything
  delayMs = 0;         // every API answer arrives this late (a weak signal)
  delayRawMs = 0;      // only photo downloads arrive this late
  listLagMs = 0;       // files saved by PUT stay out of directory listings this long (GitHub read-after-write lag)
  offline = false;
  #savedAt = new Map();
  seed(path, bytes) { this.files.set(path, { bytes, sha: gitSha(bytes) }); }

  // -> { status, headers?, body?: Buffer|string } or 'offline'
  async handle(method, url, headers, body) {
    if (method === 'OPTIONS') return { status: 204 };
    const accept0 = headers.Accept || headers.accept || '';
    const delay = this.delayMs + (accept0.includes('raw') ? this.delayRawMs : 0);
    if (delay) await wait(delay);
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
      if (this.rejectNextPut) { const st = this.rejectNextPut; this.rejectNextPut = null; return json(st, { message: 'Validation Failed' }); }
      const existing = this.files.get(path);
      if (existing && req.sha !== existing.sha) return json(422, { message: existing && !req.sha ? 'Invalid request.\n\n"sha" wasn\'t supplied.' : 'sha does not match' });
      this.seed(path, Buffer.from(req.content, 'base64'));
      this.#savedAt.set(path, Date.now());
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
    for (const [p, f] of this.files) if (p.startsWith(prefix) && !(Date.now() - (this.#savedAt.get(p) ?? 0) < this.listLagMs)) {
      const name = p.slice(prefix.length).split('/')[0], isFile = !p.slice(prefix.length).includes('/');
      kids.set(name, { name, path: prefix + name, sha: isFile ? f.sha : '', type: isFile ? 'file' : 'dir' });
    }
    return kids.size ? json(200, [...kids.values()]) : json(404, { message: 'Not Found' });
  }
}
const json = (status, obj) => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Fake Up Bank API v1. Each token sees its own accounts and transactions plus the joint ones.
export const UP = 'https://api.up.com.au/api/v1/';
class FakeUp {
  tokens = {};                 // { me, partner }: reassign one to revoke it
  offline = false;
  rateLimitNext = null;        // seconds: the next request gets a 429 with Retry-After
  calls = [];                  // 'METHOD path?query who'
  data = { me: null, partner: null, joint: { accounts: [], transactions: [] } };
  categories = []; tags = []; attachments = {};
  load(f) {
    this.data = { me: structuredClone(f.me), partner: structuredClone(f.partner), joint: structuredClone(f.joint) };
    this.categories = f.categories; this.tags = f.tags; this.attachments = f.attachments;
    return this;
  }
  #list(key) { return this.data[key].transactions; }
  add(key, t) { this.#list(key).push(t); }
  replace(key, id, t) { const l = this.#list(key); l[l.findIndex(x => x.id === id)] = t; }
  remove(key, id) { const l = this.#list(key); l.splice(l.findIndex(x => x.id === id), 1); }

  handle(method, url, headers) {
    if (method === 'OPTIONS') return { status: 204 };
    if (this.offline) return 'offline';
    const u = new URL(url), path = u.pathname.slice(new URL(UP).pathname.length);
    const auth = (headers.Authorization || headers.authorization || '').replace(/^Bearer /, '');
    const who = Object.keys(this.tokens).find(k => this.tokens[k] && this.tokens[k] === auth);
    this.calls.push(`${method} ${path}${u.search} ${who ?? 'nobody'}`);
    if (this.rateLimitNext != null) {
      const s = this.rateLimitNext; this.rateLimitNext = null;
      return { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(s) }, body: JSON.stringify({ errors: [{ status: '429', title: 'Too Many Requests' }] }) };
    }
    if (!who) return json(401, { errors: [{ status: '401', title: 'Not Authorized', detail: 'The request was not authenticated because no valid credential was found in the Authorization header, or the Authorization header was not present.' }] });
    if (method !== 'GET') return json(405, { errors: [{ status: '405' }] });
    const mine = this.data[who];
    if (!mine) return json(401, { errors: [{ status: '401' }] });
    const page = (items) => {
      const size = Number(u.searchParams.get('page[size]') || 10), after = Number(u.searchParams.get('page[after]') || 0);
      const next = after + size < items.length ? (() => { const n = new URL(u); n.searchParams.set('page[after]', String(after + size)); return n.toString(); })() : null;
      return json(200, { data: items.slice(after, after + size), links: { prev: null, next } });
    };
    if (path === 'util/ping') return json(200, { meta: { id: 'ping', statusEmoji: '⚡️' } });
    if (path === 'accounts') return page([...mine.accounts, ...this.data.joint.accounts]);
    if (path === 'transactions') {
      const since = u.searchParams.get('filter[since]');
      let items = [...mine.transactions, ...this.data.joint.transactions];
      if (since) items = items.filter(t => new Date(t.attributes.createdAt) >= new Date(since));
      items.sort((a, b) => new Date(b.attributes.createdAt) - new Date(a.attributes.createdAt));
      return page(items);
    }
    if (path === 'categories') return json(200, { data: this.categories });
    if (path === 'tags') return page(this.tags);
    const att = path.match(/^attachments\/(.+)$/);
    if (att) return this.attachments[att[1]] ? json(200, { data: this.attachments[att[1]] }) : json(404, { errors: [{ status: '404' }] });
    return json(404, { errors: [{ status: '404', title: 'Not Found' }] });
  }
}

export async function launch({ local = false, camera = 'granted' } = {}) {
  // Local mode serves the working tree from http://localhost (a secure context, so passkeys and service workers
  // work); the service worker's own fetches can't be intercepted over CDP, so a real server is the honest path.
  let siteOffline = false, server = null, site = SITE;
  if (local) {
    server = createServer((req, res) => {
      if (process.env.HARNESS_DEBUG) console.error('[srv]', req.url, siteOffline ? 'OFFLINE' : '');
      if (siteOffline) return req.socket.destroy();
      const path = new URL(req.url, 'http://localhost').pathname;
      const rel = path.startsWith('/keel/') ? decodeURIComponent(path.slice(6)) || 'index.html' : null;
      if (!rel || rel.includes('..') || !existsSync(rel) || statSync(rel).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(readFileSync(rel));
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    site = `http://localhost:${server.address().port}/keel/`;
  }
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
  // One browser-level connection with flattened sessions: the page, plus any service worker it registers,
  // so the worker's own fetches (precache, offline serving) also go through the fakes below.
  let version;
  for (let i = 0; i < 50 && !version; i++) { version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()).catch(() => null); if (!version) await wait(100); }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

  const github = new FakeGitHub(), up = new FakeUp();
  let id = 0, page = null; const pending = {};
  const raw = (method, params = {}, sessionId) => new Promise((ok, bad) => {
    pending[++id] = m => m.error ? bad(new Error(`${method}: ${m.error.message}`)) : ok(m.result);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const send = (method, params = {}) => raw(method, params, page); // tests talk to the page
  const intercept = { patterns: [{ urlPattern: API + '*' }, { urlPattern: UP + '*' }, ...(local ? [] : [{ urlPattern: SITE + '*' }])] };

  ws.onmessage = async e => {
    const m = JSON.parse(e.data);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; return; }
    if (process.env.HARNESS_DEBUG && (m.method === 'Target.attachedToTarget' || m.method === 'Fetch.requestPaused')) console.error('[cdp]', m.method, m.params.targetInfo?.type ?? '', m.params.request?.url ?? '', m.sessionId ?? 'browser', m.params.waitingForDebugger ?? '');
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo, waitingForDebugger } = m.params;
      if (waitingForDebugger) raw('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    if (m.method !== 'Fetch.requestPaused') return;
    const s = m.sessionId, { requestId, request, networkId } = m.params;
    const reply = (method, params) => raw(method, { requestId, ...params }, s);
    try {
      if (request.url.startsWith(API)) {
        let body = request.postData;
        if (body === undefined && request.postDataEntries) body = Buffer.concat(request.postDataEntries.map(x => Buffer.from(x.bytes || '', 'base64'))).toString();
        if (body === undefined && request.hasPostData) body = (await raw('Network.getRequestPostData', { requestId: networkId }, s)).postData;
        const r = await github.handle(request.method, request.url, request.headers, body);
        if (r === 'offline') return await reply('Fetch.failRequest', { errorReason: 'InternetDisconnected' });
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, accept, content-type', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
        const headers = Object.entries({ ...cors, ...(r.headers || {}) }).map(([name, value]) => ({ name, value }));
        return await reply('Fetch.fulfillRequest', { responseCode: r.status, responseHeaders: headers, body: b64(r.body ?? '') });
      }
      if (request.url.startsWith(UP)) {
        const r = up.handle(request.method, request.url, request.headers);
        if (r === 'offline') return await reply('Fetch.failRequest', { errorReason: 'InternetDisconnected' });
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After' };
        const headers = Object.entries({ ...cors, ...(r.headers || {}) }).map(([name, value]) => ({ name, value }));
        return await reply('Fetch.fulfillRequest', { responseCode: r.status, responseHeaders: headers, body: b64(r.body ?? '') });
      }
      if (request.url.startsWith(SITE) && siteOffline) return await reply('Fetch.failRequest', { errorReason: 'InternetDisconnected' });
      return await reply('Fetch.continueRequest', {});
    } catch (err) { if (process.env.HARNESS_DEBUG || !/Invalid InterceptionId|No session|Session with given id/.test(err.message)) console.error('harness:', request.url, err.message); } // the page moved on
  };

  const targets = (await raw('Target.getTargets')).targetInfos;
  page = (await raw('Target.attachToTarget', { targetId: targets.find(t => t.type === 'page').targetId, flatten: true })).sessionId;
  await send('Network.enable');
  // no Network.setCacheDisabled: it stalls service-worker fetches in Edge; the local server sends no-store instead
  await send('Page.enable');
  await send('Fetch.enable', intercept);
  // Headless Edge always has a built-in fake camera, so "no camera" is simulated on the test side.
  if (camera === 'none') await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));` });

  let clockScript = null;
  const H = {
    github, up, send, wait,
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
      await send('Page.navigate', { url: site + path });
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
    setSiteOffline(on) { siteOffline = on; }, // the page's own files fail too (a cold start with no signal)
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
    close() { try { ws.close(); edge.kill(); server?.close(); server?.closeAllConnections?.(); } catch {} setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1000); },
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
