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

const calls = H.github.calls;
console.log('api calls:', calls.length, calls.every(c => c.startsWith('GET https://api.github.com/repos/PokornyPokorny/keel-data ')) ? 'all to keel-data' : calls);
H.close(); process.exit(0);
