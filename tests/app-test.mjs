// Headless Edge over CDP with a virtual Face ID authenticator and a fake GitHub API.
// usage: node tests/app-test.mjs [local]   — "local" serves ./index.html in place of the live page.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';

const URL_ = 'https://pokornypokorny.github.io/keel/';
const local = process.argv[2] === 'local';
const GOOD = 'github_pat_good', BAD = 'github_pat_bad';

const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'edge-')), 'about:blank']);
const wait = ms => new Promise(r => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50 && !tabs; i++) { await wait(200); tabs = await fetch('http://127.0.0.1:9334/json').then(r => r.json()).catch(() => null); }
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

let id = 0; const pending = {}; const apiCalls = [];
const send = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
const b64 = s => Buffer.from(s).toString('base64');
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (pending[m.id]) { pending[m.id](m.result ?? m.error); delete pending[m.id]; return; }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'authorization, accept' }];
  if (request.url.startsWith('https://api.github.com/')) {
    if (request.method === 'OPTIONS') return send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
    const auth = request.headers.Authorization || request.headers.authorization || '';
    apiCalls.push(request.url + ' ' + auth);
    const ok = auth === 'Bearer ' + GOOD;
    return send('Fetch.fulfillRequest', { requestId, responseCode: ok ? 200 : 401,
      responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }], body: b64(ok ? '{"private":true}' : '{"message":"Bad credentials"}') });
  }
  if (local && request.url.split('?')[0] === URL_)
    return send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: b64(readFileSync('index.html')) });
  send('Fetch.continueRequest', { requestId });
};

await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.github.com/*' }, { urlPattern: URL_ + '*' }] });
await send('WebAuthn.enable');
const { authenticatorId } = await send('WebAuthn.addVirtualAuthenticator', { options: {
  protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
  isUserVerified: true, automaticPresenceSimulation: true } });

const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result.value;
const state = () => ev(`JSON.stringify({screen: ['token','setup','locked','app'].filter(s => !document.getElementById(s).hidden).join(','),
  error: [...document.querySelectorAll('.error')].map(e => e.textContent).join(''),
  token: localStorage.getItem('keel-token'), passkey: !!localStorage.getItem('keel-passkey')})`);
const log = async label => console.log((label + ':').padEnd(16), await state());
const enterToken = t => ev(`(()=>{document.querySelector('#token input').value=${JSON.stringify(t)}; document.getElementById('token').requestSubmit();})()`);

await send('Page.navigate', { url: URL_ + '?t=' + Date.now() }); await wait(2500);
await log('first open');
await enterToken(BAD); await wait(1000);
await log('bad code');
await enterToken(GOOD); await wait(1000);
await log('good code');
await ev(`document.getElementById('setup-on').click()`); await wait(1500);
await log('face id on');

// Face ID refused: stays locked.
await send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await send('Page.reload'); await wait(2500);
await log('reopen, no face');
// Face ID accepted.
await send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
await ev(`document.getElementById('unlock').click()`); await wait(1500);
await log('tap unlock');
// Leaving the app locks it.
await send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await ev(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}); document.dispatchEvent(new Event('visibilitychange'))`); await wait(300);
await log('app hidden');

console.log('api calls:', apiCalls.length, apiCalls.every(c => c.startsWith('https://api.github.com/repos/PokornyPokorny/keel-data ')) ? 'all to keel-data' : apiCalls);
edge.kill(); process.exit(0);
