// The Up Bank API, read-only, straight from the phone (Up allows any site to call it). Tokens never go anywhere else.
import * as store from './money-store.js';

const API = 'https://api.up.com.au/api/v1/';
const DAY = 864e5;

export class UpError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; } // unauthorized | offline | http
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(token, url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.timeout?.(30000) });
    } catch { throw new UpError('offline', 'No connection'); }
    if (r.status === 401) throw new UpError('unauthorized', 'Up rejected the token', 401);
    if (r.status === 429) { await sleep(Math.min(Number(r.headers.get('Retry-After')) || 2 ** attempt, 60) * 1000); continue; }
    if (!r.ok) throw new UpError('http', 'Up answered ' + r.status, r.status);
    return r.json();
  }
  throw new UpError('http', 'Up kept saying slow down', 429);
}

export const ping = async token => { await get(token, API + 'util/ping'); };

export async function pageAll(token, path) {
  const items = [];
  for (let url = API + path; url;) {
    const body = await get(token, url);
    items.push(...body.data);
    url = body.links?.next ?? null;
  }
  return items;
}

export const attachmentUrl = async (token, id) => (await get(token, API + 'attachments/' + encodeURIComponent(id))).data.attributes.fileURL;

// Bring the phone's copy up to date. Per person with a token: a full pull when nothing is stored, when forced, or
// once a week (catches older transactions recategorised in Up); otherwise accounts plus the 14 days before the
// newest stored transaction. One person's failure never touches the other's stored data.
export async function sync({ tokens, now = new Date(), force = false }) {
  const stored = await store.load();
  const lastFull = { ...(stored.meta.lastFull ?? {}) };
  const status = {};
  let fullDone = false;
  for (const who of ['me', 'partner']) {
    const token = tokens?.[who];
    if (!token) { status[who] = 'skipped'; continue; }
    try {
      const have = stored.pulls[who];
      const full = force || !have?.transactions.length || !lastFull[who] || now - new Date(lastFull[who]) >= 7 * DAY;
      const accounts = await pageAll(token, 'accounts?page[size]=100');
      if (full) {
        const txns = await pageAll(token, 'transactions?page[size]=100');
        await store.saveFull(who, accounts, txns);
        lastFull[who] = now.toISOString();
        fullDone = true;
      } else {
        const newest = Math.max(...have.transactions.map(t => new Date(t.attributes.createdAt).getTime()));
        const since = new Date(newest - 14 * DAY).toISOString();
        const txns = await pageAll(token, `transactions?page[size]=100&filter[since]=${encodeURIComponent(since)}`);
        await store.mergeRecent(who, accounts, txns, since);
      }
      status[who] = 'ok';
    } catch (e) {
      if (!(e instanceof UpError)) throw e;
      status[who] = e.code === 'unauthorized' ? 'rejected' : 'offline';
    }
  }
  const okToken = ['me', 'partner'].map(w => status[w] === 'ok' && tokens[w]).find(Boolean);
  if (okToken && (fullDone || !stored.categories.length)) {
    try {
      await store.setMeta('categories', (await get(okToken, API + 'categories')).data);
      await store.setMeta('tags', await pageAll(okToken, 'tags?page[size]=100'));
    } catch { /* categories refresh next time */ }
  }
  let updatedAt = stored.meta.updatedAt ?? null;
  if (okToken) {
    updatedAt = now.toISOString();
    await store.setMeta('updatedAt', updatedAt);
    await store.setMeta('lastFull', lastFull);
  }
  return { status, updatedAt };
}
