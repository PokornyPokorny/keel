// What this phone keeps: used days, photos waiting to upload, downloaded photos (IndexedDB),
// plus reveal progress and a one-time notice (localStorage).

let opening;
const db = () => opening ??= new Promise((ok, bad) => {
  const r = indexedDB.open('keel', 1);
  r.onupgradeneeded = () => { for (const s of ['used', 'queue', 'photos']) r.result.createObjectStore(s); };
  r.onsuccess = () => {
    const d = r.result;
    d.onclose = () => { opening = null; };                       // WebKit drops the connection after a resume
    d.onversionchange = () => { d.close(); opening = null; };
    ok(d);
  };
  r.onerror = () => bad(r.error);
}).catch(e => { opening = null; throw e; });

// A dropped connection ("connection lost", "is closing") is reopened and the work retried once.
async function run(store, mode, fn, retry = true) {
  try {
    const t = (await db()).transaction(store, mode);
    const done = new Promise((ok, bad) => { t.oncomplete = ok; t.onerror = t.onabort = () => bad(t.error); });
    const r = fn(t.objectStore(store));
    const result = await new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    await done;
    return result;
  } catch (e) {
    if (!retry) throw e;
    opening = null;
    return run(store, mode, fn, false);
  }
}

// Photos are kept as plain bytes: WebKit has had bugs where Blobs stored in IndexedDB become unreadable.
const pack = async blob => ({ type: blob.type, bytes: await blob.arrayBuffer() });
const unpack = v => v instanceof Blob || !v ? v : new Blob([v.bytes], { type: v.type });

// A day is 'used' once the camera picture appears, and 'taken' once its photo is safe on this phone.
export const markUsed = day => run('used', 'readwrite', s => s.put(1, day));
export const markTaken = day => run('used', 'readwrite', s => s.put('taken', day));
export const isUsed = async day => !!(await run('used', 'readonly', s => s.get(day)));
export const dayState = async day => { const v = await run('used', 'readonly', s => s.get(day)); return v === 'taken' ? 'taken' : v ? 'used' : null; };

export const enqueue = async (day, blob) => { const v = await pack(blob); return run('queue', 'readwrite', s => s.put(v, day)); };
export const queuedDays = async () => (await run('queue', 'readonly', s => s.getAllKeys())).sort();
export const queuedBlob = async day => unpack(await run('queue', 'readonly', s => s.get(day)));
export const dequeue = day => run('queue', 'readwrite', s => s.delete(day));

export const cachePut = async (day, blob) => { const v = await pack(blob); return run('photos', 'readwrite', s => s.put(v, day)); };
export const cacheGet = async day => unpack(await run('photos', 'readonly', s => s.get(day)));

const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export function revealPos(month) {
  const v = get('keel-reveal-' + month);
  return v === null ? null : v === 'done' ? 'done' : Number(v);
}
export const setRevealPos = (month, v) => put('keel-reveal-' + month, String(v));

// Last listings seen from GitHub, so months still unlock and list offline.
const getJson = (k, fallback) => { try { return JSON.parse(get(k)) ?? fallback; } catch { return fallback; } };
export const saveMonths = months => put('keel-months', JSON.stringify(months));
export const savedMonths = () => getJson('keel-months', []);
export const saveDays = (month, days) => put('keel-days-' + month, JSON.stringify(days));
export const savedDays = month => getJson('keel-days-' + month, []);

export function takeNotice() {
  const v = get('keel-notice');
  try { localStorage.removeItem('keel-notice'); } catch {}
  return v;
}
export const setNotice = text => put('keel-notice', text);
