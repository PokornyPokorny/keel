// Drives headless Edge over CDP: loads the page, enters the passcode, reports what's visible.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
const [url, codeFile] = process.argv.slice(2);
const code = readFileSync(codeFile, 'utf8').trim();
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'edge-')), 'about:blank']);
let tabs; for (let i = 0; i < 50 && !tabs; i++) { await new Promise(r => setTimeout(r, 200)); tabs = await fetch('http://127.0.0.1:9333/json').then(r => r.json()).catch(() => null); }
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = {};
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; } };
const send = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const state = () => ev(`JSON.stringify({lockVisible: getComputedStyle(document.getElementById('lock')).display !== 'none', appHidden: document.getElementById('app').hidden, stored: localStorage.getItem('keel-unlocked') !== null, value: document.querySelector('#lock input').value})`);
await send('Page.navigate', { url }); await new Promise(r => setTimeout(r, 2500));
console.log('on load:      ', await state());
const submit = c => ev(`(()=>{const i=document.querySelector('#lock input'); i.value=${JSON.stringify(c)}; document.getElementById('lock').requestSubmit();})()`);
await submit('wrong-code'); await new Promise(r => setTimeout(r, 800));
console.log('wrong code:   ', await state());
await submit(code.toUpperCase()); // iOS may capitalise the first letter; the page lowercases input
await new Promise(r => setTimeout(r, 800));
console.log('after submit: ', await state());
await send('Page.reload'); await new Promise(r => setTimeout(r, 2000));
console.log('after reload: ', await state());
edge.kill(); process.exit(0);
