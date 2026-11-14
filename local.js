// What this phone keeps: used days, photos waiting to upload, downloaded photos (IndexedDB),
// plus reveal progress and a one-time notice (localStorage).

let opening;
const db = () => opening ??= new Promise((ok, bad) => {
  const r = indexedDB.open('keel', 1);
  r.onupgradeneeded = () => { for (const s of ['used', 'queue', 'photos']) r.result.createObjectStore(s); };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => bad(r.error);
});

async function run(store, mode, fn) {
  const t = (await db()).transaction(store, mode);
  const done = new Promise((ok, bad) => { t.oncomplete = ok; t.onerror = t.onabort = () => bad(t.error); });
  const r = fn(t.objectStore(store));
  const result = await new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  await done;
  return result;
}

export const markUsed = day => run('used', 'readwrite', s => s.put(1, day));
export const isUsed = async day => !!(await run('used', 'readonly', s => s.get(day)));

export const enqueue = (day, blob) => run('queue', 'readwrite', s => s.put(blob, day));
export const queuedDays = async () => (await run('queue', 'readonly', s => s.getAllKeys())).sort();
export const queuedBlob = day => run('queue', 'readonly', s => s.get(day));
export const dequeue = day => run('queue', 'readwrite', s => s.delete(day));

export const cachePut = (day, blob) => run('photos', 'readwrite', s => s.put(blob, day));
export const cacheGet = day => run('photos', 'readonly', s => s.get(day));

const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export function revealPos(month) {
  const v = get('keel-reveal-' + month);
  return v === null ? null : v === 'done' ? 'done' : Number(v);
}
export const setRevealPos = (month, v) => put('keel-reveal-' + month, String(v));

export function takeNotice() {
  const v = get('keel-notice');
  try { localStorage.removeItem('keel-notice'); } catch {}
  return v;
}
export const setNotice = text => put('keel-notice', text);
