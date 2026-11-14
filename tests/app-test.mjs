// GitHub code + Face ID gate, in headless Edge with a virtual authenticator and a fake GitHub API.
// usage: node tests/app-test.mjs [local]   — "local" serves the working tree in place of the live site.
import { launch } from './harness.mjs';

const H = await launch({ local: process.argv[2] === 'local' });
const GOOD = H.github.token, BAD = 'github_pat_bad';
const authenticatorId = await H.addFaceId();

const state = () => H.eval(`JSON.stringify({screen: ['token','setup','locked','app'].filter(s => !document.getElementById(s).hidden).join(','),
  error: [...document.querySelectorAll('#token .error, #setup .error, #locked .error')].map(e => e.textContent).join(''),
  token: localStorage.getItem('keel-token'), passkey: !!localStorage.getItem('keel-passkey')})`);
const log = async label => console.log((label + ':').padEnd(16), await state());
const enterToken = t => H.eval(`(()=>{document.querySelector('#token input').value=${JSON.stringify(t)}; document.getElementById('token').requestSubmit();})()`);

await H.open('?t=' + Date.now()); await H.wait(1500);
await log('first open');
const frozen = await H.eval(`getComputedStyle(document.documentElement).overflow === 'hidden' && getComputedStyle(document.getElementById('token')).touchAction === 'none'`);
if (!frozen) console.log('NOT FROZEN: the code screen can scroll');
await enterToken(BAD); await H.wait(1000);
await log('bad code');
await enterToken(GOOD); await H.wait(1000);
await log('good code');
await H.eval(`document.getElementById('setup-on').click()`); await H.wait(1500);
await log('face id on');

// Face ID refused: stays locked.
await H.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await H.reload(); await H.wait(1500);
await log('reopen, no face');
// Face ID accepted.
await H.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
await H.eval(`document.getElementById('unlock').click()`); await H.wait(1500);
await log('tap unlock');
// Leaving the app locks it.
await H.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await H.eval(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}); document.dispatchEvent(new Event('visibilitychange'))`); await H.wait(300);
await log('app hidden');

// "api calls" counts the code checks (GET on the repo itself); every call of any kind must stay inside keel-data.
const REPO = 'https://api.github.com/repos/PokornyPokorny/keel-data';
const calls = H.github.calls, url = c => c.split(' ')[1];
const codeChecks = calls.filter(c => c.startsWith('GET ') && url(c) === REPO);
console.log('api calls:', codeChecks.length, calls.every(c => url(c) === REPO || url(c).startsWith(REPO + '/contents/')) ? 'all to keel-data' : calls);
H.close(); process.exit(0);
