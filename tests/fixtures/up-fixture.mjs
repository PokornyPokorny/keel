// Made-up Up Bank data for two made-up people (Alex Smith and Sam Jones), in Up's JSON:API shapes.
// Fixed dates, Sep–Nov 2026; tests pin the clock to NOW. Every case a money rule must handle is in here.
export const NOW = '2026-11-14T12:00:00';               // local (Brisbane, +10:00)
export const PEOPLE = { me: { first: 'Alex', surname: 'Smith' }, partner: { first: 'Sam', surname: 'Jones' } };
export const TOKENS = { me: 'up:yeah:alex', partner: 'up:yeah:sam' };

const CATS = [
  ['home', null, 'Home'], ['groceries', 'home', 'Groceries'], ['rent-and-mortgage', 'home', 'Rent & Mortgage'], ['utilities', 'home', 'Utilities'],
  ['good-life', null, 'Good Life'], ['takeaway', 'good-life', 'Takeaway'], ['tv-and-music', 'good-life', 'TV & Music'], ['games-and-software', 'good-life', 'Apps, Games & Software'],
  ['transport', null, 'Transport'], ['public-transport', 'transport', 'Public Transport'], ['fuel', 'transport', 'Fuel'],
  ['personal', null, 'Personal'], ['fitness-and-wellbeing', 'personal', 'Fitness & Wellbeing'],
];
const PARENT = Object.fromEntries(CATS.map(([id, p]) => [id, p]));

const acct = (id, name, accountType, ownershipType, cents) => ({
  type: 'accounts', id,
  attributes: { displayName: name, accountType, ownershipType, balance: { currencyCode: 'AUD', value: (cents / 100).toFixed(2), valueInBaseUnits: cents }, createdAt: '2025-01-01T09:00:00+10:00' },
  relationships: { transactions: { links: { related: `https://api.up.com.au/api/v1/accounts/${id}/transactions` } } },
});

// tx(id, account, cents, createdAt, opts)
function tx(id, account, cents, createdAt, o = {}) {
  const cat = o.cat ?? null;
  return {
    type: 'transactions', id,
    attributes: {
      status: o.held ? 'HELD' : 'SETTLED', rawText: o.raw ?? null, description: o.desc ?? 'Something', message: o.message ?? null,
      isCategorizable: o.categorizable ?? true,
      roundUp: o.roundUp ? { amount: { currencyCode: 'AUD', value: (o.roundUp / 100).toFixed(2), valueInBaseUnits: o.roundUp }, boostPortion: null } : null,
      cashback: null,
      amount: { currencyCode: 'AUD', value: (cents / 100).toFixed(2), valueInBaseUnits: cents },
      foreignAmount: o.foreign ? { currencyCode: o.foreign[0], value: (o.foreign[1] / 100).toFixed(2), valueInBaseUnits: o.foreign[1] } : null,
      cardPurchaseMethod: o.card ? { method: o.card[0], cardNumberSuffix: o.card[1] } : null,
      holdInfo: o.held ? { amount: { currencyCode: 'AUD', value: (cents / 100).toFixed(2), valueInBaseUnits: cents }, foreignAmount: null } : null,
      settledAt: o.held ? null : createdAt, createdAt,
      transactionType: o.type ?? (cents < 0 ? 'Purchase' : 'Direct Credit'),
      note: o.note ? { text: o.note } : null,
      performingCustomer: o.by ? { displayName: o.by } : null,
      deepLinkURL: `up://transaction/${id}`,
    },
    relationships: {
      account: { data: { type: 'accounts', id: account } },
      transferAccount: { data: o.to ? { type: 'accounts', id: o.to } : null },
      category: { data: cat ? { type: 'categories', id: cat } : null },
      parentCategory: { data: cat && PARENT[cat] ? { type: 'categories', id: PARENT[cat] } : null },
      tags: { data: (o.tags ?? []).map(t => ({ type: 'tags', id: t })) },
      attachment: { data: o.attachment ? { type: 'attachments', id: o.attachment } : null },
    },
  };
}
const T = (d, hm = '09:00') => `2026-${d}T${hm}:00+10:00`;   // d = 'MM-DD'

export function fixture() {
  const own = (from, fromAcct, toAcct, cents, d, desc) => [
    tx(`${from}-out`, fromAcct, -cents, T(d, '08:00'), { categorizable: false, type: 'Transfer', to: toAcct, desc }),
    tx(`${from}-in`, toAcct, cents, T(d, '08:00'), { categorizable: false, type: 'Transfer', to: fromAcct, desc: 'Transfer from Spending' }),
  ];
  const me = {
    accounts: [acct('a-spend', 'Spending', 'TRANSACTIONAL', 'INDIVIDUAL', 41218), acct('a-holiday', 'Holiday', 'SAVER', 'INDIVIDUAL', 180000), acct('a-rainy', 'Rainy day', 'SAVER', 'INDIVIDUAL', 125000)],
    transactions: [
      // pay
      tx('a-pay-sep', 'a-spend', 105000, T('09-13'), { desc: 'Acme Pty Ltd', type: 'Salary' }),
      tx('a-pay-oct', 'a-spend', 105000, T('10-13'), { desc: 'Acme Pty Ltd', type: 'Salary' }),
      tx('a-pay-nov', 'a-spend', 105000, T('11-13'), { desc: 'Acme Pty Ltd', type: 'Salary' }),
      // groceries; the last one has a receipt and a round-up
      tx('a-woo-1', 'a-spend', -8000, T('09-05'), { desc: 'Woolworths', cat: 'groceries' }),
      tx('a-woo-2', 'a-spend', -9000, T('10-03'), { desc: 'Woolworths', cat: 'groceries' }),
      tx('a-woo-3', 'a-spend', -7000, T('10-20'), { desc: 'Woolworths', cat: 'groceries' }),
      tx('a-woo-4', 'a-spend', -6000, T('11-03'), { desc: 'Woolworths', cat: 'groceries' }),
      tx('a-woo-5', 'a-spend', -3420, T('11-14', '09:15'), { desc: 'Woolworths Toowong', cat: 'groceries', raw: 'WOOLWORTHS 4410 TOOWONG QLD AUS', roundUp: -80, card: ['CONTACTLESS', '4821'], tags: ['weekly-shop'], note: 'Big shop', attachment: 'att-1' }),
      tx('a-ru-1', 'a-holiday', 80, T('11-14', '09:15'), { desc: 'Round Up', type: 'Round Up', categorizable: false }),
      // a round-up into a saver that has since been closed
      tx('a-ru-old', 'a-closed', 50, T('09-10'), { desc: 'Round Up', type: 'Round Up', categorizable: false }),
      // monthly, weekly, fortnightly repeats
      tx('a-nf-sep', 'a-spend', -1699, T('09-02'), { desc: 'Netflix', cat: 'tv-and-music' }),
      tx('a-nf-oct', 'a-spend', -1699, T('10-02'), { desc: 'Netflix', cat: 'tv-and-music' }),
      tx('a-nf-nov', 'a-spend', -1699, T('11-02'), { desc: 'Netflix', cat: 'tv-and-music' }),
      ...['10-20', '10-27', '11-03', '11-10'].map((d, i) => tx(`a-gym-${i}`, 'a-spend', -2500, T(d, '06:00'), { desc: 'Goodlife Health', cat: 'fitness-and-wellbeing' })),
      ...['10-10', '10-24', '11-07'].map((d, i) => tx(`a-rent-${i}`, 'a-spend', -48000, T(d, '07:00'), { desc: 'Rent Co', cat: 'rent-and-mortgage', type: 'Payment' })),
      // seen twice only: not a repeat
      tx('a-kmart-1', 'a-spend', -4000, T('10-05'), { desc: 'Kmart', cat: 'groceries' }),
      tx('a-kmart-2', 'a-spend', -4000, T('11-05'), { desc: 'Kmart', cat: 'groceries' }),
      // monthly but amounts vary over 15%: not a repeat
      ...[['09-08', -3000], ['10-08', -9000], ['11-08', -4500]].map(([d, c], i) => tx(`a-shell-${i}`, 'a-spend', c, T(d), { desc: 'Shell', cat: 'fuel' })),
      // pending
      tx('a-uber-held', 'a-spend', -1840, T('11-14', '10:00'), { desc: 'Uber', cat: 'public-transport', held: true }),
      // foreign currency
      tx('a-steam', 'a-spend', -2500, T('10-15'), { desc: 'Steam', cat: 'games-and-software', foreign: ['USD', -1600] }),
      // 23:30 on 31 Oct in Brisbane, stamped in Melbourne summer time: belongs to October
      tx('a-latepizza', 'a-spend', -2000, '2026-11-01T00:30:00+11:00', { desc: 'Late Pizza', cat: 'takeaway' }),
      // interest
      tx('a-int-nov', 'a-holiday', 312, T('11-01', '03:00'), { desc: 'Interest', type: 'Interest', categorizable: false }),
      // own transfer into a saver
      ...own('a-hol-nov', 'a-spend', 'a-holiday', 10000, '11-13', 'Transfer to Holiday'),
      ...own('a-rainy-oct', 'a-spend', 'a-rainy', 6000, '10-14', 'Transfer to Rainy day'),
      // Alex pays Sam (names the payee): pairs with Sam's deposit one day later
      tx('a-to-sam', 'a-spend', -5000, T('11-05', '18:00'), { desc: 'Sam Jones', type: 'Transfer' }),
      // a payment that names nobody: never pairs, stays spend
      tx('a-plumber', 'a-spend', -3000, T('11-07', '12:00'), { desc: 'Plumber Co', type: 'Payment', cat: 'utilities' }),
      // money into the joint House from Alex's own account
      tx('a-to-house', 'a-spend', -20000, T('10-01'), { categorizable: false, type: 'Transfer', to: 'j-house', desc: 'Transfer to House' }),
    ],
  };
  const partner = {
    accounts: [acct('s-spend', 'Spending', 'TRANSACTIONAL', 'INDIVIDUAL', 52480), acct('s-house', 'House deposit', 'SAVER', 'INDIVIDUAL', 360000)],
    transactions: [
      tx('s-pay-oct', 's-spend', 110000, T('10-13'), { desc: 'Beta Ltd', type: 'Salary' }),
      tx('s-pay-nov', 's-spend', 110000, T('11-13'), { desc: 'Beta Ltd', type: 'Salary' }),
      tx('s-coles-oct', 's-spend', -6000, T('10-08'), { desc: 'Coles', cat: 'groceries' }),
      tx('s-coles-nov', 's-spend', -5500, T('11-08'), { desc: 'Coles', cat: 'groceries' }),
      tx('s-gyg', 's-spend', -3600, T('11-14', '11:00'), { desc: 'Guzman y Gomez', cat: 'takeaway', card: ['CONTACTLESS', '1093'] }),
      // the deposit from Alex: pairs (Alex's payment names "Jones", same amount, 1 day apart)
      tx('s-from-alex', 's-spend', 5000, T('11-06', '09:00'), { desc: 'Alex Smith', type: 'Transfer' }),
      // same amount as Alex's payment but 4 days later: outside the 3-day window, stays income
      tx('s-refund', 's-spend', 5000, T('11-09', '09:00'), { desc: 'Big W refund', type: 'Direct Credit' }),
      // matches the plumber payment's amount and day, but that payment named nobody: stays income
      tx('s-plumber-back', 's-spend', 3000, T('11-07', '12:30'), { desc: 'Plumber refund', type: 'Direct Credit' }),
      ...own('s-house-nov', 's-spend', 's-house', 25000, '11-13', 'Transfer to House deposit'),
      tx('s-to-house', 's-spend', -30000, T('10-02'), { categorizable: false, type: 'Transfer', to: 'j-house', desc: 'Transfer to House' }),
    ],
  };
  const joint = {
    accounts: [acct('j-house', 'House', 'SAVER', 'JOINT', 50200), acct('j-bills', 'Bills', 'TRANSACTIONAL', 'JOINT', 2000)],
    transactions: [
      tx('j-house-from-a', 'j-house', 20000, T('10-01'), { categorizable: false, type: 'Transfer', to: 'a-spend', desc: 'Transfer from Alex' }),
      tx('j-house-from-s', 'j-house', 30000, T('10-02'), { categorizable: false, type: 'Transfer', to: 's-spend', desc: 'Transfer from Sam' }),
      tx('j-house-outside', 'j-house', 5000, T('10-20'), { desc: 'Sam Jones', type: 'Transfer', by: 'Sam Jones', categorizable: false }),
      tx('j-house-gift', 'j-house', 1000, T('10-25'), { desc: 'Gift', type: 'Direct Credit', categorizable: false }),
      tx('j-house-int', 'j-house', 200, T('11-01', '03:00'), { desc: 'Interest', type: 'Interest', categorizable: false }),
      tx('j-house-out', 'j-house', -6000, T('11-10'), { categorizable: false, type: 'Transfer', to: 'j-bills', desc: 'Transfer to Bills' }),
      tx('j-bills-in', 'j-bills', 6000, T('11-10'), { categorizable: false, type: 'Transfer', to: 'j-house', desc: 'Transfer from House' }),
      tx('j-origin', 'j-bills', -4000, T('11-12'), { desc: 'Origin Energy', cat: 'utilities', by: 'Sam Jones' }),
    ],
  };
  const categories = CATS.map(([id, parent, name]) => ({
    type: 'categories', id, attributes: { name },
    relationships: { parent: { data: parent ? { type: 'categories', id: parent } : null }, children: { data: CATS.filter(c => c[1] === id).map(c => ({ type: 'categories', id: c[0] })) } },
  }));
  const tags = [{ type: 'tags', id: 'weekly-shop' }];
  const attachments = { 'att-1': { type: 'attachments', id: 'att-1', attributes: { fileURL: 'https://up-attachments.example/att-1.jpg', fileURLExpiresAt: '2026-11-14T13:00:00+10:00', fileExtension: 'jpg', fileContentType: 'image/jpeg', createdAt: T('11-14', '09:20') } } };
  return { categories, tags, attachments, me, partner, joint };
}
