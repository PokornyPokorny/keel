// Photos in the private repo PokornyPokorny/keel-data, through the GitHub Contents API.
import { photoPath } from './days.js';

const API = 'https://api.github.com/repos/PokornyPokorny/keel-data/contents/';

export class GitHubError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; } // code: unauthorized | offline | http
}

async function call(token, path, { method = 'GET', body, raw = false } = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method, cache: 'no-store', body: body && JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + token, Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
                 ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch { throw new GitHubError('offline', 'No connection'); }
  if (r.status === 401) throw new GitHubError('unauthorized', 'GitHub rejected the code', 401);
  return r;
}
const httpError = r => new GitHubError('http', 'GitHub answered ' + r.status, r.status);

async function listDir(token, path) {
  const r = await call(token, path);
  if (r.status === 404) return [];
  if (!r.ok) throw httpError(r);
  const items = await r.json();
  return Array.isArray(items) ? items : [];
}

export async function listMonths(token) {
  const years = (await listDir(token, 'photos')).filter(i => i.type === 'dir' && /^\d{4}$/.test(i.name));
  const months = await Promise.all(years.map(async y =>
    (await listDir(token, 'photos/' + y.name)).filter(i => i.type === 'dir' && /^\d{2}$/.test(i.name)).map(i => `${y.name}-${i.name}`)));
  return months.flat().sort();
}

export async function listDays(token, month) {
  const [y, m] = month.split('-');
  return (await listDir(token, `photos/${y}/${m}`))
    .map(i => i.name).filter(n => /^\d{4}-\d{2}-\d{2}\.jpg$/.test(n)).map(n => n.slice(0, 10)).sort();
}

export async function getPhoto(token, day) {
  const r = await call(token, photoPath(day), { raw: true });
  if (!r.ok) throw httpError(r);
  return new Blob([await r.arrayBuffer()], { type: 'image/jpeg' });
}

export async function remoteSha(token, day) {
  const r = await call(token, photoPath(day));
  if (r.status === 404) return null;
  if (!r.ok) throw httpError(r);
  return (await r.json()).sha;
}

// No sha in the body, so GitHub refuses (422) if the day already has a file: one photo per day, enforced server side.
export async function putPhoto(token, day, blob) {
  const r = await call(token, photoPath(day), { method: 'PUT', body: { message: 'photo ' + day, content: await toBase64(blob) } });
  if (r.status === 201 || r.status === 200) return 'saved';
  if (r.status === 422) return 'exists';
  throw httpError(r);
}

// Git's blob id: sha1("blob <size>\0" + bytes). Lets a retry recognise its own earlier upload.
export async function blobSha(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head); all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map(b => b.toString(16).padStart(2, '0')).join('');
}

const toBase64 = blob => new Promise((ok, bad) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]);
  r.onerror = () => bad(r.error);
  r.readAsDataURL(blob);
});
