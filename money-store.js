// Money data kept on this phone: each person's Up pull (accounts + transactions) and a little metadata.
// IndexedDB database `keel-money`, separate from photo a day's `keel`, so neither ever migrates the other.

let opening;
const db = () => opening ??= new Promise((ok, bad) => {
  const r = indexedDB.open('keel-money', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('txns', { keyPath: 'key' }).createIndex('who', 'who');
    d.createObjectStore('accounts', { keyPath: 'key' }).createIndex('who', 'who');
    d.createObjectStore('meta');
  };
  r.onsuccess = () => {
    const d = r.result;
    d.onclose = () => { opening = null; };                       // WebKit drops the connection after a resume
    d.onversionchange = () => { d.close(); opening = null; };
    ok(d);
  };
  r.onerror = () => bad(r.error);
}).catch(e => { opening = null; throw e; });

// One transaction over `stores`; `fn` gets the stores and returns a request (or nothing). Reopens once on a dropped connection.
async function run(stores, mode, fn, retry = true) {
  try {
    const t = (await db()).transaction(stores, mode);
    const done = new Promise((ok, bad) => { t.oncomplete = ok; t.onerror = t.onabort = () => bad(t.error); });
    const r = fn(...[stores].flat().map(s => t.objectStore(s)));
    const result = r ? await new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); }) : undefined;
    await done;
    return result;
  } catch (e) {
    if (!retry) throw e;
    opening = null;
    return run(stores, mode, fn, false);
  }
}
const all = (store, who) => run(store, 'readonly', s => s.index('who').getAll(who));
const wrap = (who, item) => ({ key: `${who}:${item.id}`, who, item });

export async function load() {
  const meta = Object.fromEntries(await run('meta', 'readonly', s => s.getAllKeys())
    .then(keys => Promise.all(keys.map(async k => [k, await run('meta', 'readonly', s => s.get(k))]))));
  const pulls = {};
  for (const who of ['me', 'partner']) {
    const [accounts, txns] = await Promise.all([all('accounts', who), all('txns', who)]);
    if (accounts.length || txns.length) pulls[who] = { accounts: accounts.map(x => x.item), transactions: txns.map(x => x.item) };
  }
  return { pulls, categories: meta.categories ?? [], tags: meta.tags ?? [], meta };
}

// Replace everything stored for one person with a full pull.
export async function saveFull(who, accounts, txns) {
  const [oldT, oldA] = await Promise.all([all('txns', who), all('accounts', who)]);
  await run(['txns', 'accounts'], 'readwrite', (t, a) => {
    for (const x of oldT) t.delete(x.key);           // deletes and puts run in order within the transaction
    for (const x of oldA) a.delete(x.key);
    for (const x of accounts) a.put(wrap(who, x));
    for (const x of txns) t.put(wrap(who, x));
  });
}

// Merge a recent pull: accounts replaced, transactions upserted, and this person's pending (HELD) ones created since
// `sinceISO` that Up no longer lists are dropped (they settled under a new id, or were cancelled).
export async function mergeRecent(who, accounts, txns, sinceISO) {
  const fresh = new Set(txns.map(x => x.id)), since = new Date(sinceISO);
  const stale = (await all('txns', who)).filter(x => x.item.attributes.status === 'HELD' && new Date(x.item.attributes.createdAt) >= since && !fresh.has(x.item.id));
  const oldAccounts = await all('accounts', who);
  await run(['txns', 'accounts'], 'readwrite', (t, a) => {
    for (const x of oldAccounts) a.delete(x.key);
    for (const x of accounts) a.put(wrap(who, x));
    for (const x of stale) t.delete(x.key);
    for (const x of txns) t.put(wrap(who, x));
  });
}

export const setMeta = (k, v) => run('meta', 'readwrite', s => s.put(v, k));

// Remove everything stored for one person (their token was removed).
export async function forget(who) {
  const [t, a] = await Promise.all([all('txns', who), all('accounts', who)]);
  await run(['txns', 'accounts'], 'readwrite', (ts, as) => { for (const x of t) ts.delete(x.key); for (const x of a) as.delete(x.key); });
}
