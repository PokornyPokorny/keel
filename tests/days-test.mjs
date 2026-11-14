// Unit tests for days.js (pure date logic). Run: node tests/days-test.mjs
import assert from 'node:assert/strict';
const d = await import('../days.js');

const cases = {
  'dayKey uses the local date': () => assert.equal(d.dayKey(new Date(2026, 10, 14, 23, 59)), '2026-11-14'),
  'monthOf': () => assert.equal(d.monthOf('2026-11-14'), '2026-11'),
  'photoPath': () => assert.equal(d.photoPath('2026-10-03'), 'photos/2026/10/2026-10-03.jpg'),
  'daysInMonth incl. leap years': () => {
    assert.equal(d.daysInMonth('2026-10'), 31); assert.equal(d.daysInMonth('2028-02'), 29); assert.equal(d.daysInMonth('2026-02'), 28);
  },
  'isUnlocked flips at local midnight on the 1st, incl. year rollover': () => {
    assert.equal(d.isUnlocked('2026-10', new Date(2026, 9, 31, 23, 59, 59)), false);
    assert.equal(d.isUnlocked('2026-10', new Date(2026, 10, 1, 0, 0, 0)), true);
    assert.equal(d.isUnlocked('2026-12', new Date(2027, 0, 1)), true);
    assert.equal(d.isUnlocked('2026-11', new Date(2026, 10, 30)), false);
  },
  'monthGrid first week is Monday-first with leading blanks': () =>
    assert.deepEqual(d.monthGrid('2026-10')[0], [null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']),
  'monthGrid holds every day once': () => assert.equal(d.monthGrid('2026-10').flat().filter(Boolean).length, 31),
  'monthGrid weeks are 7 wide': () => assert.ok(d.monthGrid('2026-10').every(w => w.length === 7)),
  'monthLabel this year': () => assert.equal(d.monthLabel('2026-10', new Date(2026, 10, 1)), 'October'),
  'monthLabel other year': () => assert.equal(d.monthLabel('2025-10', new Date(2026, 10, 1)), 'October 2025'),
  'shortDate': () => assert.equal(d.shortDate('2026-10-03'), '3 Oct'),
  'pendingReveals: unlocked, non-empty, oldest first': () => assert.deepEqual(d.pendingReveals(MONTHS, () => false, new Date(2026, 10, 14)), ['2026-09', '2026-10']),
  'pendingReveals skips revealed months': () => assert.deepEqual(d.pendingReveals(MONTHS, m => m === '2026-09', new Date(2026, 10, 14)), ['2026-10']),
};
const MONTHS = [{ month: '2026-10', days: ['2026-10-01'] }, { month: '2026-09', days: ['2026-09-02'] },
                { month: '2026-08', days: [] }, { month: '2026-11', days: ['2026-11-01'] }];

let passed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { fn(); passed++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); }
}
console.log(`days-test: ${passed}/${Object.keys(cases).length} passed`);
process.exitCode = passed === Object.keys(cases).length ? 0 : 1;
