// Money: Keel's home. Up Bank data for one or two people, read straight from Up on this phone.
// Layout follows the approved mockup (Mix 1, Split style): amber owns spending, mint owns saving and money in.
import * as R from './money-rules.js';
import * as up from './up.js';
import * as store from './money-store.js';
import { dayKey, monthGrid } from './days.js';

const K = { me: 'keel-up-token-me', partner: 'keel-up-token-partner', people: 'keel-people', status: 'keel-up-status' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FEED_CAP = 150;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = c => (c < 0 ? '−' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = c => Math.round(c / 100).toLocaleString('en-AU');
const big = c => { const [d, p] = (Math.abs(c) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split('.'); return `${d}<small>.${p}</small>`; };
const monthKey = d => dayKey(d).slice(0, 7);
const monthStart = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1); };
const monthEnd = m => { const s = monthStart(m); return new Date(s.getFullYear(), s.getMonth() + 1, 1, 0, 0, 0, -1); };
const monthName = m => MONTHS[Number(m.slice(5, 7)) - 1];
const shiftMonth = (m, n) => monthKey(new Date(monthStart(m).getFullYear(), monthStart(m).getMonth() + n, 1));
const short = d => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const time12 = d => d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, ' ').toLowerCase();

export function startMoney({ root, onPhotos }) {
  root.innerHTML = `
    <div id="money" class="mny"></div>
    <div id="m-sheet" class="mny layer sheet-layer" hidden></div>
    <div id="m-balance" class="mny layer sheet-layer" hidden></div>
    <div id="m-settings" class="mny layer scroll" hidden></div>`;
  const $ = s => root.querySelector(s);
  const screen = $('#money'), sheet = $('#m-sheet'), balSheet = $('#m-balance'), settings = $('#m-settings');
  const S = { view: 'all', month: null, chip: '', showAll: false, catsOpen: false, data: null, offline: false, syncing: null };

  const tokens = () => ({ me: ls.get(K.me) || '', partner: ls.get(K.partner) || '' });
  const people = () => ls.json(K.people, { me: { first: '', surname: '' }, partner: { first: '', surname: '' } });
  const first = w => w === 'joint' ? 'Joint' : (people()[w]?.first || (w === 'me' ? 'Me' : 'Partner'));
  const initial = w => w === 'joint' ? 'J' : first(w)[0].toUpperCase();

  // ---- data: the phone's copy, stamped and paired once per load ----
  async function loadData() {
    const d = await store.load(), t = tokens();
    const pulls = ['me', 'partner'].filter(w => d.pulls[w] && t[w]).map(w => ({ who: w, ...d.pulls[w], syncedAt: d.meta.lastSync?.[w] }));
    if (!pulls.length) return null;
    const st = R.stamp(pulls);
    R.pairBetween(st.txns, people());
    return { ...st, categories: d.categories, updatedAt: d.meta.updatedAt ?? null, lastFull: d.meta.lastFull ?? {}, who: pulls.map(p => p.who) };
  }

  async function refresh() {
    const t = tokens();
    if (!t.me && !t.partner) { S.data = null; render(); return; }
    try { S.data = await loadData(); } catch { S.data = null; }
    render();
    return runSync(false);
  }

  // Syncs run one at a time, each with the tokens as they are when it starts. A token removed while a sync
  // was running gets its data dropped again afterwards, so Remove always sticks.
  function runSync(force) {
    S.syncing = (S.syncing ?? Promise.resolve()).catch(() => {}).then(async () => {
      const t = tokens();
      if (t.me || t.partner) {
        try {
          const res = await up.sync({ tokens: t, now: new Date(), force });
          ls.set(K.status, JSON.stringify(res.status));
          S.offline = !Object.values(res.status).includes('ok');
        } catch { S.offline = true; }
      }
      for (const w of ['me', 'partner']) if (!tokens()[w]) await store.forget(w).catch(() => {});
      try { S.data = await loadData(); } catch {}
      render();
      if (!settings.hidden) renderSettings();
    });
    return S.syncing;
  }

  // ---- freshness line ----
  function fresh() {
    const st = ls.json(K.status, {}), rejected = ['me', 'partner'].filter(w => tokens()[w] && st[w] === 'rejected');
    if (rejected.length) return `Up rejected ${rejected.map(w => esc(first(w)) + "'s").join(' and ')} token · <button type="button" class="inline-link" data-act="settings">Money settings</button>`;
    if (!S.data?.updatedAt) return S.offline ? 'Offline' : 'Updating…';
    const at = new Date(S.data.updatedAt), mins = Math.floor((Date.now() - at) / 60000);
    const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : dayKey(at) === dayKey(new Date()) ? time12(at) : short(at);
    return S.offline ? `Offline · from ${when}` : `Updated ${when}`;
  }

  // ---- the Money screen ----
  function render() {
    const P = people();
    const top = `<div class="m-top"><a href="#" id="photos-link">Photos</a><b>Money</b>
      <button type="button" class="icon-btn" data-act="settings" aria-label="Money settings"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg></button></div>`;
    if (!S.data) {
      screen.innerHTML = `${top}<div class="m-emptybox">${tokens().me || tokens().partner ? '<p class="m-empty">Getting your money from Up…</p>'
        : '<p class="m-empty">Connect Up to see your money here.</p><button type="button" class="primary" id="m-connect" data-act="settings">Open Money settings</button>'}</div>`;
      return;
    }
    const now = new Date(), cur = monthKey(now), month = S.month || cur, current = month === cur;
    const at = current ? now : monthEnd(month), mStart = monthStart(month), prev = shiftMonth(month, -1);
    const { accounts, txns, categories } = S.data, v = S.view;
    const sum = R.summary(txns, v, month, now);
    const cats = R.categories(txns, v, month, categories, now);
    const day = R.daily(txns, v, month, now);
    const sv = R.savers(accounts, txns, v, mStart, at);
    const bal = R.balanceAt(accounts, txns, at);
    const reps = R.repeats(txns, v, now), merch = R.merchants(txns, v, month, now);
    const catName = Object.fromEntries(categories.map(c => [c.id, c.attributes.name]));
    const hasJoint = accounts.some(a => a.owner === 'joint');

    // whose
    const views = ['all', ...S.data.who, ...(hasJoint ? ['joint'] : [])];
    const whose = views.length > 2 ? `<div class="whose" role="group" aria-label="Whose money">${views.map(w =>
      `<button type="button" data-act="view" data-v="${w}" aria-pressed="${w === v}">${esc(w === 'all' ? 'All' : first(w))}</button>`).join('')}</div>` : '';

    // hero
    const diff = sum.out - sum.prevOutToSameMoment, pName = monthName(prev);
    const diffTxt = diff === 0 ? `The same as ${pName}${current ? ' by now' : ''}` : `${money(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than ${pName}${current ? ' by now' : ''}`;
    const spendAccts = accounts.filter(a => a.attributes.accountType === 'TRANSACTIONAL' && (v === 'all' || a.owner === v));
    const spendBal = spendAccts.reduce((s, a) => s + bal[a.id], 0);
    const days = sum.outByDay.length;
    const hero = `<div class="hero"><span class="micro spend">Spent · ${current ? `day ${now.getDate()} / ${days}` : monthName(month)}</span>
      <span class="big">${big(sum.out)}</span>
      <div class="row"><span>${esc(diffTxt)}</span><span class="muted">Spending${spendAccts.length > 1 ? ` · ${spendAccts.length} accounts` : ''} ${money(spendBal)}</span></div></div>`;
    const tiles = `<div class="tiles">
      <div class="tile"><span class="micro save">In</span><b class="save">${whole(sum.in)}</b></div>
      <div class="tile"><span class="micro spend">Out</span><b class="spend">${whole(sum.out)}</b></div>
      <div class="tile"><span class="micro save">Net</span><b class="save">${sum.net >= 0 ? '+' : '−'}${whole(Math.abs(sum.net))}</b></div></div>`;

    // running line: this month against last
    const cum = a => a.reduce((acc, x) => (acc.push((acc.at(-1) || 0) + x), acc), []);
    const nowLine = cum(sum.outByDay).slice(0, current ? now.getDate() : days), prevLine = cum(sum.prevOutByDay);
    const top_ = Math.max(1, ...nowLine, ...prevLine), W = 340, Hh = 100;
    const pts = (arr, n) => arr.map((y, i) => `${(i / Math.max(1, n - 1) * W).toFixed(1)},${(Hh - 4 - y / top_ * (Hh - 10)).toFixed(1)}`).join(' ');
    const lastX = nowLine.length ? ((nowLine.length - 1) / Math.max(1, days - 1) * W).toFixed(1) : 0, lastY = nowLine.length ? (Hh - 4 - nowLine.at(-1) / top_ * (Hh - 10)).toFixed(1) : Hh - 4;
    const chart = `<div class="panel"><svg viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="Spending through ${esc(monthName(month))} against ${esc(pName)}">
        <polyline points="${pts(prevLine, prevLine.length)}" fill="none" stroke="#48484a" stroke-width="2" stroke-linejoin="round"/>
        ${nowLine.length ? `<polyline points="${pts(nowLine, days)}" fill="none" stroke="var(--spend)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--spend)"/>` : ''}
      </svg><div class="legend"><span><span class="dot" style="background:var(--spend)"></span>${esc(monthName(month))} <span class="dot" style="background:#636366;margin-left:8px"></span>${esc(pName)}</span><span>${esc(diffTxt)}</span></div></div>`;

    // where it went
    const topCat = cats[0]?.total || 1, shownCats = S.catsOpen ? cats : cats.slice(0, 4);
    const where = cats.length ? `<div class="panel"><span class="micro spend">Where it went</span>
      <div class="chips"><button type="button" class="chip${S.chip === '' ? ' on' : ''}" data-act="chip" data-cat="">All</button>${cats.map(c =>
        `<button type="button" class="chip${S.chip === (c.id ?? 'none') ? ' on' : ''}" data-act="chip" data-cat="${esc(c.id ?? 'none')}">${esc(c.name)}</button>`).join('')}</div>
      ${shownCats.map((c, i) => `<div class="cat"><div class="cat-line"><span>${esc(c.name)}</span><span${i === 0 ? ' class="spend"' : ''}>${money(c.total)}</span></div>
        <div class="bar"><i class="${i === 0 ? 'lead' : ''}" style="width:${(c.total / topCat * 100).toFixed(1)}%"></i></div>
        ${c.subs.length ? `<span class="sub">${c.subs.map(s => `${esc(s.name)} ${money(s.total)}`).join(' · ')}</span>` : ''}</div>`).join('')}
      ${cats.length > 4 ? `<button type="button" class="linkish" data-act="cats">${S.catsOpen ? 'Fewer' : `${cats.length - 4} more · ${money(cats.slice(4).reduce((s, c) => s + c.total, 0))}`}</button>` : ''}</div>` : '';

    // daily heatmap
    const maxDay = Math.max(1, ...Object.values(day.byDay));
    const heat = `<div class="panel"><span class="micro spend">Daily</span><div class="heat" aria-label="Daily spending in ${esc(monthName(month))}">
      ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span class="h">${d}</span>`).join('')}
      ${monthGrid(month).flat().map(k => {
        if (!k) return '<span class="blank"></span>';
        const c = day.byDay[k] ?? 0, lvl = c / maxDay, future = current && k > dayKey(now);
        return `<span${future || !c ? '' : ` style="background:color-mix(in srgb,var(--spend) ${Math.round(8 + lvl * 92)}%,#161618)${lvl > .7 ? ';color:#000' : ''}"`} title="${k}: ${money(c)}">${Number(k.slice(8))}</span>`;
      }).join('')}</div>
      <div class="legend"><span>${day.highest.day ? `Highest: ${DOW[new Date(day.highest.day + 'T12:00').getDay()]} ${short(new Date(day.highest.day + 'T12:00'))} · ${money(day.highest.cents)}` : 'Nothing spent yet'}</span><span>Average ${money(day.average)} a day</span></div></div>`;

    // savers
    const owners = ['me', 'partner', 'joint'].filter(w => (v === 'all' || v === w) && (w !== 'partner' || S.data.who.includes('partner')) && (w !== 'joint' || hasJoint));
    const svRows = sv.rows.map(r => `<button type="button" class="sv-row" data-act="balance" data-acct="${esc(r.id)}">
        <span class="sv-line"><span class="sv-name">${esc(r.name)}<small>${esc(r.owner === 'joint' ? '2Up saver · joint' : `${first(r.owner)} · Saver`)}</small></span>
        <span class="sv-bal">${money(r.balance)}<small class="save">${r.monthDelta >= 0 ? '+' : '−'}${money(Math.abs(r.monthDelta))} this month</small></span></span>
        <span class="sv-bar"><i style="width:${(r.share * 100).toFixed(1)}%"></i></span></button>`).join('');
    const savers = sv.rows.length ? `<section class="panel" aria-label="Savers">
      <div class="row" style="align-items:baseline"><span class="micro save">Savers</span><span class="muted small">${owners.map(w => `${esc(first(w).replace('Joint', 'joint'))} ${money(sv.byOwner[w])}`).join(' · ')}</span></div>
      <span class="sv-total save">${money(sv.total)}</span>${svRows}
      <div class="foot"><span class="save">${sv.savedThisMonth >= 0 ? '+' : '−'}${money(Math.abs(sv.savedThisMonth))} saved in ${esc(monthName(month))}</span><span>Round-ups ${money(sv.roundupsThisMonth)}</span></div></section>` : '';

    // joint: whose money
    let joint = '';
    if (hasJoint && (v === 'all' || v === 'joint')) {
      const js = R.jointSplit(txns, accounts, people(), current ? null : at);
      const rows = accounts.filter(a => a.owner === 'joint').map(a => {
        const sp = js[a.id] ?? {}, b = bal[a.id] || 0, parts = ['me', 'partner', 'unknown'].filter(w => sp[w] > 0);
        return `<button type="button" class="sv-row" data-act="balance" data-acct="${esc(a.id)}"><span class="sv-line"><span class="sv-name">${esc(a.attributes.displayName)}<small>${a.attributes.accountType === 'SAVER' ? '2Up saver' : '2Up spending'}</small></span><span class="sv-bal">${money(b)}</span></span>
          <span class="split" role="img" aria-label="${parts.map(w => `${w === 'unknown' ? 'Not known' : first(w)} ${Math.round(sp[w] / (b || 1) * 100)}%`).join(', ')}">${parts.map(w => `<i class="p-${w}" style="flex:${sp[w].toFixed(2)}"></i>`).join('')}</span>
          <span class="legend">${parts.map(w => `<span><span class="dot p-${w}"></span>${esc(w === 'unknown' ? 'Not known' : first(w))} ${money(Math.round(sp[w]))}</span>`).join('')}</span></button>`;
      }).join('');
      joint = `<section class="panel" aria-label="Joint accounts"><span class="micro">Joint · whose money</span>${rows}</section>`;
    }

    // feed
    const parentOf = t => t.relationships.parentCategory?.data?.id ?? t.relationships.category?.data?.id ?? 'none';
    let list = txns.filter(t => (v === 'all' || t.owner === v) && monthKey(new Date(t.attributes.createdAt)) === month);
    if (S.chip) list = list.filter(t => R.classify(t) === 'spend' && parentOf(t) === S.chip);
    const more = !S.showAll && list.length > FEED_CAP;
    if (more) list = list.slice(0, FEED_CAP);
    const groups = [];
    for (const t of list) { const k = dayKey(new Date(t.attributes.createdAt)); if (groups.at(-1)?.k !== k) groups.push({ k, items: [] }); groups.at(-1).items.push(t); }
    const coming = current ? reps.filter(r => r.next >= new Date(now.getFullYear(), now.getMonth(), now.getDate()) && r.next - now < 14 * 864e5) : [];
    const row = t => {
      const c = R.classify(t), a = t.attributes, sub = t.relationships.category?.data?.id;
      const bits = [c === 'internal' ? (t.pair ? 'Between you' : 'Transfer') : sub ? catName[sub] : c === 'income' ? 'Money in' : 'Uncategorised'];
      if (a.status === 'HELD') bits.push('<span class="spend">pending</span>');
      if (a.cardPurchaseMethod?.cardNumberSuffix) bits.push(`card ··${esc(a.cardPurchaseMethod.cardNumberSuffix)}`);
      const amt = R.cents(t);
      return `<button type="button" class="tx" data-act="tx" data-tx="${esc(t.id)}" data-parent="${esc(parentOf(t))}"><span><span><span class="who" aria-label="${esc(first(t.owner))}">${esc(initial(t.owner))}</span>${esc(a.description)}</span><small>${bits.map((b, i) => i === 0 ? esc(b) : b).join(' · ')}</small></span>
        <span class="${c === 'income' ? 'save' : c === 'internal' ? 'muted' : ''}">${amt > 0 ? '+' : ''}${money(Math.abs(amt))}</span></button>`;
    };
    const feed = `<div class="feed">
      ${coming.length ? `<span class="micro" style="padding-top:2px">Coming</span><div class="items coming">${coming.map(r =>
        `<div class="tx"><span>${DOW[r.next.getDay()]} ${r.next.getDate()} · ${esc(r.name)}<small>${r.every}</small></span><span class="spend">${money(r.amount)}</span></div>`).join('')}</div>` : ''}
      ${groups.map(g => {
        const d = new Date(g.k + 'T12:00'), o = g.items.filter(t => R.classify(t) === 'spend').reduce((s, t) => s - R.cents(t), 0), i = g.items.filter(t => R.classify(t) === 'income').reduce((s, t) => s + R.cents(t), 0);
        return `<span class="day">${DOW[d.getDay()]}<span>${d.getDate()}</span></span><div class="items"><span class="muted small">${money(o)} out${i ? ` · <span class="save">${money(i)} in</span>` : ''} · ${g.items.length}</span>${g.items.map(row).join('')}</div>`;
      }).join('')}
      ${!groups.length ? '<span></span><div class="items"><span class="muted small">Nothing here yet</span></div>' : ''}
    </div>${more ? `<button type="button" class="linkish center" data-act="earlier">Show earlier</button>` : ''}`;

    const perMonth = reps.reduce((s, r) => s + r.perMonth, 0);
    const two = `<div class="two">
      <div class="panel"><span class="micro spend">Repeats</span><b>${money(perMonth).replace(/\.\d\d$/, '')}<span class="per"> /mo</span></b><p>${reps.slice(0, 3).map(r => `${esc(r.name)} ${whole(r.amount)} · ${r.every}`).join('<br>') || 'None found yet'}</p></div>
      <div class="panel"><span class="micro spend">Most often</span><b class="merch">${esc(merch[0]?.name ?? '—')}</b><p>${merch[0] ? `${merch[0].count}× · ${money(merch[0].total)}` : ''}${merch.slice(1, 3).map(m => `<br>${esc(m.name)} ${m.count}×`).join('')}</p></div></div>`;
    const partnerName = S.data.who.includes('partner') ? first('partner') : null;
    const foot = `<p class="fine">Transfers between your own accounts${partnerName ? ` and between you and ${esc(partnerName)}` : ''} aren't counted as spending. Purchases with cash out count fully as spending.${current ? '' : " Closed savers aren't shown."}</p>`;

    screen.innerHTML = `${top}${whose}
      <div class="month"><button type="button" data-act="month" data-d="-1" aria-label="${esc(monthName(prev))}">‹</button>
        <span>${esc(monthName(month))} ${month.slice(0, 4)}<small>${fresh()}</small></span>
        <button type="button" data-act="month" data-d="1" aria-label="Next month"${current ? ' disabled' : ''}>›</button></div>
      ${hero}${tiles}${chart}${where}${heat}${savers}${joint}${feed}${two}${foot}`;
  }

  // ---- a transaction ----
  function openTx(id) {
    const t = S.data?.txns.find(x => x.id === id);
    if (!t) return;
    const a = t.attributes, rel = t.relationships, catName = Object.fromEntries(S.data.categories.map(c => [c.id, c.attributes.name]));
    const acct = S.data.accounts.find(x => x.id === rel.account?.data?.id), to = S.data.accounts.find(x => x.id === rel.transferAccount?.data?.id);
    const dt = s => s ? `${DOW[new Date(s).getDay()]} ${short(new Date(s))}, ${time12(new Date(s))}` : '';
    const ru = a.roundUp?.amount, fx = a.foreignAmount, cp = a.cardPurchaseMethod;
    const m = monthKey(new Date(a.createdAt)), same = S.data.txns.filter(x => x.attributes.description === a.description && monthKey(new Date(x.attributes.createdAt)) === m && R.classify(x) === 'spend');
    const kv = (k, v, cls = '') => `<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`;
    const none = '<span class="muted">None</span>';
    const cat = rel.category?.data?.id ? `${esc(catName[rel.category.data.id])}${rel.parentCategory?.data?.id ? ` <span class="muted">· ${esc(catName[rel.parentCategory.data.id])}</span>` : ''}` : none;
    const amt = R.cents(t);
    sheet.innerHTML = `<div class="sheet-back" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-label="${esc(a.description)}">
      <div class="sheet-head"><span class="grab" aria-hidden="true"></span><button type="button" class="x" id="m-sheet-close" data-act="close-sheet" aria-label="Close">×</button></div>
      <h2>${esc(a.description)}</h2>
      <span class="amount ${amt > 0 ? 'save' : 'spend'}">${amt > 0 ? '+' : '−'}${money(Math.abs(amt))}</span>
      <dl class="kv">
        ${kv('Status', a.status === 'HELD' ? '<span class="spend">Pending</span>' : `Settled · ${esc(dt(a.settledAt))}`)}
        ${kv('Made', esc(dt(a.createdAt)))}
        ${kv('Category', cat)}
        ${kv('Tags', rel.tags?.data?.length ? rel.tags.data.map(x => `<span class="pill">${esc(x.id)}</span>`).join('') : none)}
        ${kv('Paid with', cp ? `${esc(cp.method.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()))}${cp.cardNumberSuffix ? ` · card ··${esc(cp.cardNumberSuffix)}` : ''}` : none)}
        ${kv('Round-up', ru ? money(Math.abs(Number(ru.valueInBaseUnits))) : none, ru ? 'save' : '')}
        ${kv('Cashback', a.cashback ? `${money(Number(a.cashback.amount.valueInBaseUnits))} · ${esc(a.cashback.description)}` : none)}
        ${kv('Foreign', fx ? `${esc(fx.currencyCode)} ${(Math.abs(Number(fx.valueInBaseUnits)) / 100).toFixed(2)}` : none)}
        ${kv('Account', acct ? `${esc(acct.attributes.displayName)} · ${esc(first(acct.owner))}` : '<span class="muted">A closed account</span>')}
        ${rel.transferAccount?.data?.id ? kv('Transfer', to ? esc(to.attributes.displayName) : '<span class="muted">A closed account</span>') : ''}
        ${kv('Type', a.transactionType ? esc(a.transactionType) : none)}
        ${a.performingCustomer?.displayName ? kv('Made by', esc(a.performingCustomer.displayName)) : ''}
        ${a.holdInfo ? kv('Hold', `${money(Math.abs(Number(a.holdInfo.amount.valueInBaseUnits)))}${a.holdInfo.foreignAmount ? ` · ${esc(a.holdInfo.foreignAmount.currencyCode)} ${(Math.abs(Number(a.holdInfo.foreignAmount.valueInBaseUnits)) / 100).toFixed(2)}` : ''}`) : ''}
        ${a.roundUp?.boostPortion ? kv('Round-up boost', money(Math.abs(Number(a.roundUp.boostPortion.valueInBaseUnits))), 'save') : ''}
        ${kv('Bank text', a.rawText ? `<span class="muted">${esc(a.rawText)}</span>` : none)}
        ${kv('Message', a.message ? esc(a.message) : none)}
        ${kv('Note', a.note?.text ? esc(a.note.text) : none)}
        ${R.classify(t) === 'spend' ? kv('This month', `${ordinal(same.length - same.findIndex(x => x.id === t.id))} time · ${money(same.reduce((s, x) => s - R.cents(x), 0))} in total`) : ''}
      </dl>
      ${rel.attachment?.data?.id ? `<button type="button" class="ghost-btn" id="m-receipt" data-act="receipt" data-id="${esc(rel.attachment.data.id)}" data-owner="${esc(t.owner)}">Receipt</button>` : ''}
      ${a.deepLinkURL ? `<a class="link-btn" href="${esc(a.deepLinkURL)}">Open in Up</a>` : ''}
    </div>`;
    sheet.hidden = false;
  }

  async function openReceipt(btn) {
    const t = tokens(), tok = btn.dataset.owner === 'partner' ? t.partner : t.me || t.partner;
    btn.disabled = true;
    try {
      const url = await up.attachmentUrl(tok, btn.dataset.id);
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.className = 'link-btn'; a.textContent = 'Open receipt';
      btn.replaceWith(a);
    } catch { btn.textContent = 'Receipt unavailable offline'; }
  }

  // ---- an account's balance over the last 90 days ----
  function openBalance(id) {
    const a = S.data?.accounts.find(x => x.id === id);
    if (!a) return;
    const today = new Date(), pts = [];
    for (let i = 90; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 23, 59, 59, 999);
      pts.push(R.balanceAt([a], S.data.txns, i === 0 ? today : d)[a.id]);
    }
    const lo = Math.min(...pts), hi = Math.max(...pts), W = 340, Hh = 120, span = Math.max(1, hi - lo);
    const line = pts.map((v, i) => `${(i / 90 * W).toFixed(1)},${(Hh - 8 - (v - lo) / span * (Hh - 16)).toFixed(1)}`).join(' ');
    const saver = a.attributes.accountType === 'SAVER';
    balSheet.innerHTML = `<div class="sheet-back" data-act="close-balance"></div><div class="sheet" role="dialog" aria-label="${esc(a.attributes.displayName)} balance">
      <div class="sheet-head"><span class="grab" aria-hidden="true"></span><button type="button" class="x" id="m-balance-close" data-act="close-balance" aria-label="Close">×</button></div>
      <h2>${esc(a.attributes.displayName)}</h2><span class="muted small">Balance over the last 90 days</span>
      <svg viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="Balance from ${money(pts[0])} to ${money(pts.at(-1))}"><polyline points="${line}" fill="none" stroke="${saver ? 'var(--save)' : '#fff'}" stroke-width="2.5" stroke-linejoin="round"/></svg>
      <dl class="kv"><dt>Start</dt><dd>Start ${money(pts[0])}</dd><dt>Lowest</dt><dd>${money(lo)}</dd><dt>Highest</dt><dd>${money(hi)}</dd><dt>Today</dt><dd>Today ${money(pts.at(-1))}</dd></dl>
    </div>`;
    balSheet.hidden = false;
  }

  // ---- Money settings ----
  function renderSettings() {
    const P = people(), t = tokens(), st = ls.json(K.status, {});
    const masked = s => s ? '•'.repeat(Math.min(8, s.length)) : '';
    const tokenRow = (w, label) => {
      const msg = !t[w] ? '' : st[w] === 'rejected' ? `Up rejected the saved token for ${esc(first(w))}. Paste a new one.` : 'Connected';
      return `<div class="conn-block"><label for="t-${w}">${label}</label>
        <div class="conn-row"><input id="t-${w}" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${t[w] ? 'up:yeah:•••• (saved)' : 'up:yeah:…'}">
        <button type="button" class="ghost-btn" id="t-${w}-save" data-act="token" data-w="${w}">Check &amp; save</button></div>
        <span class="tok-msg ${msg === 'Connected' ? 'save' : ''}" id="t-${w}-msg" role="status">${msg}</span>
        ${t[w] ? `<button type="button" class="linkish" data-act="remove" data-w="${w}">Remove ${w === 'me' ? 'yours' : esc(first('partner')) + "'s"}</button>` : ''}</div>`;
    };
    const lastFull = S.data?.lastFull ?? {}, lf = Object.values(lastFull).sort().at(-1);
    settings.innerHTML = `<div class="m-top"><a href="#" id="m-settings-back" data-act="close-settings">‹ Money</a><b>Money settings</b><span></span></div>
      <h3>People</h3>
      <div class="pair">
        <div class="field"><label for="n-me-first">Your first name</label><input id="n-me-first" value="${esc(P.me.first)}" autocomplete="off"></div>
        <div class="field"><label for="n-me-sur">Your surname</label><input id="n-me-sur" type="${P.me.surname ? 'password' : 'text'}" value="${esc(P.me.surname)}" autocomplete="off"></div>
        <div class="field"><label for="n-p-first">Partner's first name</label><input id="n-p-first" value="${esc(P.partner.first)}" autocomplete="off"></div>
        <div class="field"><label for="n-p-sur">Partner's surname</label><input id="n-p-sur" type="${P.partner.surname ? 'password' : 'text'}" value="${esc(P.partner.surname)}" autocomplete="off"></div>
      </div>
      <button type="button" class="ghost-btn" id="n-save" data-act="names">Save names</button>
      <p class="fine left">Used for labels and to spot money sent between you two. Kept only on this phone.</p>
      <h3>Up tokens</h3>
      ${tokenRow('me', 'Your Up token')}
      ${tokenRow('partner', `${esc(P.partner.first || 'Partner')}'s Up token (optional)`)}
      <p class="fine left">Make one at api.up.com.au/getting_started. It only reads; Keel can't move money or change anything in Up.</p>
      <h3>Data on this phone</h3>
      <div class="conn"><span><b>${S.data ? S.data.txns.length.toLocaleString('en-AU') : 0} transactions</b><small>Full re-pull every 7 days${lf ? ` · last ${esc(short(new Date(lf)))}` : ''}</small></span></div>
      <button type="button" class="primary" id="m-refresh-all" data-act="refresh-all">Refresh everything</button>
      <p class="fine left">Tokens, names and bank data stay on this phone behind Face ID. They never go to GitHub.</p>`;
  }

  async function saveToken(w) {
    const input = $(`#t-${w}`), msg = $(`#t-${w}-msg`), token = input.value.trim();
    if (!token) return;
    msg.className = 'tok-msg'; msg.textContent = 'Checking…';
    try {
      await up.ping(token);
      ls.set(K[w], token);
      const st = ls.json(K.status, {}); delete st[w]; ls.set(K.status, JSON.stringify(st));
      input.value = '';
      msg.className = 'tok-msg save'; msg.textContent = 'Connected';
      await refresh();
    } catch (e) {
      msg.textContent = e.code === 'unauthorized' ? 'Up rejected that token.' : 'No connection. Try again once you have signal.';
    }
  }

  // ---- events ----
  root.addEventListener('click', async e => {
    const el = e.target.closest('[data-act], #photos-link');
    if (!el) return;
    if (el.id === 'photos-link') { e.preventDefault(); onPhotos(); return; }
    const act = el.dataset.act;
    if (el.tagName === 'A' && act) e.preventDefault();
    if (act === 'view') { S.view = el.dataset.v; S.chip = ''; S.showAll = false; render(); }
    else if (act === 'month') { const cur = monthKey(new Date()), next = shiftMonth(S.month || cur, Number(el.dataset.d)); S.month = next > cur ? cur : next; S.chip = ''; S.showAll = false; render(); }
    else if (act === 'chip') { S.chip = el.dataset.cat; render(); }
    else if (act === 'cats') { S.catsOpen = !S.catsOpen; render(); }
    else if (act === 'earlier') { S.showAll = true; render(); }
    else if (act === 'tx') openTx(el.dataset.tx);
    else if (act === 'close-sheet') sheet.hidden = true;
    else if (act === 'receipt') openReceipt(el);
    else if (act === 'balance') openBalance(el.dataset.acct);
    else if (act === 'close-balance') balSheet.hidden = true;
    else if (act === 'settings') { renderSettings(); settings.hidden = false; settings.scrollTop = 0; }
    else if (act === 'close-settings') { settings.hidden = true; render(); }
    else if (act === 'names') {
      const v = id => $(id).value.trim();
      ls.set(K.people, JSON.stringify({ me: { first: v('#n-me-first'), surname: v('#n-me-sur') }, partner: { first: v('#n-p-first'), surname: v('#n-p-sur') } }));
      el.textContent = 'Saved';
      if (S.data) { R.pairBetween(S.data.txns, people()); }
      setTimeout(() => { el.textContent = 'Save names'; }, 1500);
    }
    else if (act === 'token') saveToken(el.dataset.w);
    else if (act === 'remove') {
      const w = el.dataset.w;
      ls.del(K[w]); await store.forget(w).catch(() => {});
      S.view = 'all'; renderSettings(); await runSync(false); renderSettings();
    }
    else if (act === 'refresh-all') {
      el.disabled = true; el.textContent = 'Refreshing…';
      await runSync(true);
    }
  });

  return { refresh };
}
