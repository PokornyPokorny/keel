// Date logic for photo a day. A day is 'YYYY-MM-DD' and a month 'YYYY-MM', both in the phone's local time.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = n => String(n).padStart(2, '0');
const parts = s => s.split('-').map(Number);

export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthOf = day => day.slice(0, 7);
export const photoPath = day => `photos/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.jpg`;

export function daysInMonth(month) {
  const [y, m] = parts(month);
  return new Date(y, m, 0).getDate();
}

// A month opens at local midnight on the 1st of the next month.
export function isUnlocked(month, now) {
  const [y, m] = parts(month);
  return now >= new Date(y, m, 1);
}

export function monthGrid(month) {
  const [y, m] = parts(month);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday = 0
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= daysInMonth(month); d++) cells.push(`${month}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function monthLabel(month, now) {
  const [y, m] = parts(month);
  return y === now.getFullYear() ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`;
}

export function shortDate(day) {
  const [, m, d] = parts(day);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

export function pendingReveals(months, revealed, now) {
  return months
    .filter(({ month, days }) => days.length && isUnlocked(month, now) && !revealed(month))
    .map(({ month }) => month)
    .sort();
}
