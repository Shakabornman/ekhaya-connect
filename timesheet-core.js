// timesheet-core.js: pure logic for checking scanned signed attendance registers (no Firebase, no screens).
// Used by timesheets.html and by the tests. A sheet is one person's list of shifts for a pay run.
// Rates are never kept in this public file: callers pass them in (from the private config in Firestore).
import { addDays, daysBetween, daysInMonth, iso } from './roster-core.js';

// ---- reading what was written -----------------------------------------------------------------------------
// "1/7/26", "01/07/2026", "28.6.26", "30,7,26" -> "2026-07-01". Two-digit years are 20xx. Returns null if not a date.
export function parseSheetDate(s) {
  const m = /^\s*(\d{1,2})\s*[\/.,\-\s]\s*(\d{1,2})\s*[\/.,\-\s]\s*(\d{2}|\d{4})\s*$/.exec(String(s ?? ''));
  if (!m) return null; const d = +m[1], mo = +m[2]; let y = +m[3]; if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; if (d > daysInMonth(y, mo)) return null; return iso(y, mo, d);
}
// "19h00", "19:00", "19.00", "0645", "06h45", "7", "07hoo" -> minutes after midnight, or null
export function parseSheetTime(s) {
  let t = String(s ?? '').trim().toLowerCase().replace(/o/g, '0').replace(/[h:.,\s]+/g, ':');
  if (/^\d{3,4}$/.test(t)) t = t.length === 3 ? t[0] + ':' + t.slice(1) : t.slice(0, 2) + ':' + t.slice(2);
  const m = /^(\d{1,2})(?::(\d{2}))?:?$/.exec(t); if (!m) return null; const h = +m[1], mi = m[2] ? +m[2] : 0;
  return h > 24 || mi > 59 ? null : h * 60 + mi;
}
// "12h00", "12hrs", "12.00", "12", "1.5", "73,5" -> number of hours, or null
export function parseHoursWritten(v) {
  if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(?:h|hrs?|hours?)?\s*(\d{2})?$/.exec(String(v).trim().toLowerCase().replace(/o/g, '0')); if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.')); return m[2] && /h/i.test(String(v)) ? n + (+m[2]) / 60 : n;
}
// hours between in and out; an out at or before the in is the next day (a night shift)
export function hoursBetween(inMin, outMin) { if (inMin == null || outMin == null) return null; let d = outMin - inMin; if (d <= 0) d += 1440; return Math.round((d / 60) * 100) / 100; }
// the shift a start time belongs to: starting before 12:00 is a day shift, otherwise a night shift
export const shiftOfStart = (inMin) => (inMin == null ? null : inMin < 12 * 60 ? 'day' : 'night');

// ---- normalise one scanned sheet -------------------------------------------------------------------------
// raw: { name, rank, month, rate, totalHours, totalAmount, managerSigned, shifts:[{date,in,out,hours,struck,managerSigned}] }
// opts: { rates: { RN: 99, EN: .., ENA: .. }, rankKey(rank) -> key }
export const RANK_KEYS = [[/^e\s*\/?\s*n\s*\/?\s*a|ena|enrolled nursing a|auxiliar/i, 'ENA'], [/^e\s*\/?\s*n$|enrolled nurse|^en\b/i, 'EN'], [/^r\s*\/?\s*n$|^rn\b|registered|prof/i, 'RN']];
export function rankKey(rank) { const r = String(rank ?? '').trim(); for (const [re, k] of RANK_KEYS) if (re.test(r)) return k; return null; }
export const money = (n) => Math.round(n * 100) / 100;

export function normaliseSheet(raw, opts = {}) {
  const flags = []; const rows = [];
  for (const s of raw.shifts || []) {
    const date = parseSheetDate(s.date), inMin = parseSheetTime(s.in), outMin = parseSheetTime(s.out);
    const calc = hoursBetween(inMin, outMin); const written = parseHoursWritten(s.hours);
    const row = { rawDate: s.date, date, in: inMin, out: outMin, shift: shiftOfStart(inMin), calcHours: calc, writtenHours: Number.isFinite(written) ? written : null, struck: !!s.struck, notes: [] };
    if (!row.struck) {
      if (!date) row.notes.push('date not readable');
      if (inMin == null || outMin == null) row.notes.push('time not readable');
      if (calc != null && row.writtenHours != null && Math.abs(calc - row.writtenHours) > 0.01) row.notes.push(`hours written ${row.writtenHours} but times give ${calc}`);
      if (calc != null && calc > 14) row.notes.push('longer than 14 hours');
    }
    row.hours = row.struck ? 0 : (row.writtenHours ?? calc ?? 0);
    // a line that starts exactly when the previous line on the same date ended is extra hours on that shift, not a new shift
    const prev = [...rows].reverse().find((x) => !x.struck);
    if (!row.struck && prev && prev.date && prev.date === date && prev.out != null && prev.out === inMin) { row.extension = true; row.shift = prev.shift; }
    rows.push(row);
  }
  const counted = rows.filter((r) => !r.struck); const dates = counted.filter((r) => r.date).map((r) => r.date);
  // duplicate start (same date and same shift twice) usually means a date typo
  const seen = new Set(); for (const r of counted) if (r.date && r.shift && !r.extension) { const k = r.date + r.shift; if (seen.has(k)) r.notes.push('same date and shift twice'); seen.add(k); }
  // a date more than two weeks from every other date on the sheet is probably a slip of the pen (for example 30.7.26 for 30.6.26)
  if (dates.length >= 3) { const sorted = [...new Set(dates)].sort(); for (const r of counted) { if (!r.date) continue; const near = sorted.filter((d) => d !== r.date).map((d) => Math.abs(daysBetween(d, r.date))); if (near.length && Math.min(...near) > 14) r.notes.push('date is far from the other dates on the sheet'); } }
  const sum = money(counted.reduce((a, r) => a + r.hours, 0)); const total = raw.totalHours == null ? null : Number(raw.totalHours);
  if (total != null && Math.abs(total - sum) > 0.01) flags.push(`Total hours on the sheet is ${total} but the shifts add up to ${sum}`);
  const key = rankKey(raw.rank); const table = opts.rates || {}; const expected = key && table[key] != null ? table[key] : null;
  const rate = raw.rate == null || raw.rate === '' ? null : Number(raw.rate);
  if (rate != null && expected != null && Math.abs(rate - expected) > 0.005) flags.push(`Rate written ${rate} but the ${key} rate is ${expected}`);
  const useRate = rate ?? expected; const amount = useRate != null ? money(sum * useRate) : null; const writtenAmount = raw.totalAmount == null ? null : Number(raw.totalAmount);
  if (amount != null && writtenAmount != null && Math.abs(amount - writtenAmount) > 0.5) flags.push(`Total amount written ${writtenAmount} but ${sum} hours at ${useRate} is ${amount}`);
  if (key == null) flags.push('Rank not recognised');
  if (!raw.managerSigned) flags.push('Manager signature not seen');
  if (rows.some((r) => r.struck)) flags.push(`${rows.filter((r) => r.struck).length} struck-out line(s) ignored`);
  for (const r of rows) for (const n of r.notes) flags.push(`${r.rawDate}: ${n}`);
  return { name: raw.name, rank: raw.rank, rankKey: key, month: raw.month, rows, sumHours: sum, totalHours: total, rate: useRate, amount, writtenAmount, flags, from: dates.length ? dates.slice().sort()[0] : null, to: dates.length ? dates.slice().sort().pop() : null };
}

// ---- pay runs: which shifts belong to which pay period ----------------------------------------------------
export const inPeriod = (date, p) => !!date && date >= p.start && date <= p.end;
export function splitByPeriod(sheet, period) { const inside = [], outside = []; for (const r of sheet.rows) { if (r.struck) continue; (inPeriod(r.date, period) ? inside : outside).push(r); } return { inside, outside, hours: money(inside.reduce((a, r) => a + r.hours, 0)) }; }

// ---- names -----------------------------------------------------------------------------------------------
const clean = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const tokenScore = (a, b) => { if (a === b) return 1; if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 0.6 : 0; const l = Math.max(a.length, b.length); return Math.max(0, 1 - lev(a, b) / l); };
// 0..1: every word on the sheet should find a close word in the employee's name; initials count a little
export function nameScore(written, full) {
  const a = clean(written).split(' ').filter(Boolean), b = clean(full).split(' ').filter(Boolean); if (!a.length || !b.length) return 0;
  let total = 0; const used = new Set();
  for (const w of a) { let best = 0, bi = -1; b.forEach((x, i) => { if (used.has(i)) return; const s = tokenScore(w, x); if (s > best) { best = s; bi = i; } }); if (bi >= 0) used.add(bi); total += best; }
  return total / a.length;
}
// candidates sorted best first; people: [{ id, name }]
export function matchPerson(written, people) { return people.map((p) => ({ ...p, score: nameScore(written, p.name) })).filter((p) => p.score >= 0.5).sort((a, b) => b.score - a.score); }

// ---- compare with the roster -------------------------------------------------------------------------------
// onDuty: Map of 'YYYY-MM-DD' -> Set of 'day'|'night' the person is rostered on (from the Off Duty grids)
export function rosterMap(config, periods, personId) {
  const m = new Map(); const rows = (config.people || []).filter((r) => r.personId === personId);
  for (const p of periods) for (const r of rows) { const sec = (config.sections || []).find((s) => s.id === r.sectionId); const str = (p.cells || {})[r.id] || ''; for (let i = 0; i < str.length; i++) if (str[i] === '1') { const d = addDays(p.start, i); if (!m.has(d)) m.set(d, new Set()); m.get(d).add(sec ? sec.shift : 'day'); } }
  return m;
}
export function coveredDays(periods) { const s = new Set(); for (const p of periods) for (let d = p.start; d <= p.end; d = addDays(d, 1)) s.add(d); return s; }
// sheetRows: counted rows of the sheet inside the pay period; window: { start, end }
// result.status per line: 'match' | 'worked-not-rostered' | 'different-shift' | 'rostered-not-worked' | 'no-roster'
export function compareToRoster(sheetRows, rostered, window, covered) {
  const lines = []; const worked = new Map();
  for (const r of sheetRows) { if (!r.date) continue; if (!worked.has(r.date)) worked.set(r.date, new Set()); if (r.shift) worked.get(r.date).add(r.shift); }
  for (const r of sheetRows) {
    if (!r.date) continue; const rs = rostered.get(r.date);
    if (!covered.has(r.date)) lines.push({ date: r.date, shift: r.shift, hours: r.hours, status: 'no-roster' });
    else if (rs && r.shift && rs.has(r.shift)) lines.push({ date: r.date, shift: r.shift, hours: r.hours, status: 'match' });
    else if (rs && rs.size) lines.push({ date: r.date, shift: r.shift, hours: r.hours, status: 'different-shift', rostered: [...rs] });
    else lines.push({ date: r.date, shift: r.shift, hours: r.hours, status: 'worked-not-rostered' });
  }
  for (const [d, rs] of [...rostered.entries()].sort()) { if (d < window.start || d > window.end || !covered.has(d)) continue; for (const sh of rs) if (!(worked.get(d) && worked.get(d).has(sh))) lines.push({ date: d, shift: sh, hours: 0, status: 'rostered-not-worked' }); }
  const count = (s) => lines.filter((l) => l.status === s).length;
  return { lines: lines.sort((a, b) => a.date.localeCompare(b.date)), match: count('match'), workedNotRostered: count('worked-not-rostered'), differentShift: count('different-shift'), rosteredNotWorked: count('rostered-not-worked'), noRoster: count('no-roster') };
}
