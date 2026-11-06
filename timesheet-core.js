// timesheet-core.js: pure logic for checking scanned signed attendance registers (no Firebase, no screens).
// Used by timesheets.html and by the tests. A sheet is one person's list of shifts for a pay run.
// Rates are never kept in this public file: callers pass them in (from the private config in Firestore).
import { addDays, daysBetween, daysInMonth, iso } from './roster-core.js';

// ---- reading what was written -----------------------------------------------------------------------------
// "1/7/26", "01/07/2026", "28.6.26", "30,7,26" -> "2026-07-01". Two-digit years are 20xx. Returns null if not a date.
// Dates as written on the registers. Staff write them every way: "23.03.26", "17/3/26", "13-03-2026", "2026-03-16", "16/3" (no year),
// "16 March", "Mon 16/3", "16" (day only), "160326", "16th", with letters for digits ("l6/O3/26") and any separator.
// South African order is day first; a 4-digit year first is read year-month-day; when only the second number can be a day it is swapped.
// ctx fills what was left out: { year, month } from the other lines or the sheet's month heading, { win: {start, end} } the pay run.
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, mrt: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12 };
export function monthFromText(t) { const m = /\b(jan|feb|mar|mrt|apr|may|mei|jun|jul|aug|sep|oct|okt|nov|dec|des)[a-z]*\b/i.exec(String(t ?? '')); return m ? MONTH_NAMES[m[1].toLowerCase()] : null; }
export function parseSheetDate(s, ctx = {}) {
  let t = String(s ?? '').toLowerCase().trim(); if (!t) return null;
  t = t.replace(/\b(mon|tues?|wed|thur?s?|fri|sat|sun)(day)?\b\.?/g, ' ').replace(/(\d)\s*(st|nd|rd|th)\b/g, '$1');
  const monthName = monthFromText(t); if (monthName) t = t.replace(/\b(jan|feb|mar|mrt|apr|may|mei|jun|jul|aug|sep|oct|okt|nov|dec|des)[a-z]*\b/, ' ');
  t = t.split(/[^0-9a-z]+/).filter(Boolean).map((k) => (/^[0-9oli]+$/.test(k) && /[0-9]/.test(k) ? k.replace(/[o]/g, '0').replace(/[li]/g, '1') : k)).join(' ');   // "l6" "O3" are written digits
  let nums = t.match(/\d+/g) || []; if (/[a-z]/.test(t.replace(/\d+/g, ''))) return null;
  if (!monthName && nums.length === 1) { const n = nums[0]; if (n.length === 8) nums = [n.slice(0, 2), n.slice(2, 4), n.slice(4)]; else if (n.length === 6) nums = [n.slice(0, 2), n.slice(2, 4), n.slice(4)]; else if (n.length === 4) nums = [n.slice(0, 2), n.slice(2)]; }
  const ok = (y, mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2099 && d <= daysInMonth(y, mo);
  const inRange = (y) => y >= 2024 && y <= 2035; const win = ctx.win || null;
  const fullYear = (k) => (k.length === 4 ? +k : k.length === 2 ? 2000 + +k : null);
  // pick the year for a day and month written without one: the other lines, then the heading, then the pay run
  const yearFor = (d, mo) => {
    const years = [...new Set([ctx.year, win && +win.start.slice(0, 4), win && +win.end.slice(0, 4)].filter(Boolean))];
    if (win) { const inside = years.filter((y) => ok(y, mo, d) && iso(y, mo, d) >= win.start && iso(y, mo, d) <= win.end); if (inside.length) return inside[0]; }
    const y = ctx.year || (win && +win.start.slice(0, 4)); return y && ok(y, mo, d) ? y : null;
  };
  const finish = (d, mo, yk) => {
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];                                                              // written month first
    if (yk != null) { const y = fullYear(yk); return y && ok(y, mo, d) ? iso(y, mo, d) : null; }
    const y = yearFor(d, mo); return y ? iso(y, mo, d) : null;
  };
  if (monthName) { if (!nums.length || nums[0].length > 2) return null; return finish(+nums[0], monthName, nums.length > 1 && [2, 4].includes(nums[nums.length - 1].length) ? nums[nums.length - 1] : null); }                    // 16 March, 16 mar 26
  if (nums.length === 3) {
    const [a, b, c] = nums;
    if (a.length === 4) { const y = +a, mo = +b, d = +c; return c.length <= 2 && ok(y, mo, d) ? iso(y, mo, d) : null; }                  // 2026-03-16
    if (a.length > 2 || b.length > 2 || (c.length !== 2 && c.length !== 4)) return null;
    let d = +a, mo = +b; if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (c.length === 4) { const y = +c; return ok(y, mo, d) ? iso(y, mo, d) : null; }                                                 // 13/03/2026
    const y1 = +c + 2000; if (!ok(y1, mo, d)) return null; if (inRange(y1)) return iso(y1, mo, d);                                     // 23.03.26
    const y2 = d + 2000, d2 = +c; return ok(y2, mo, d2) && inRange(y2) ? iso(y2, mo, d2) : iso(y1, mo, d);                              // 26.03.16 read as year first
  }
  if (nums.length === 2 && nums.every((n) => n.length <= 2)) return finish(+nums[0], +nums[1], null);                                  // 16/3, 16.03
  if (nums.length === 1 && nums[0].length <= 2) {                                                                                        // 16
    const d = +nums[0]; const months = [ctx.month, win && +win.start.slice(5, 7), win && +win.end.slice(5, 7)].filter(Boolean);
    for (const mo of [...new Set(months)]) { const y = yearFor(d, mo); if (!y) continue; const x = iso(y, mo, d); if (!win || (x >= win.start && x <= win.end)) return x; }
    return ctx.month ? finish(d, ctx.month, null) : null;
  }
  return null;
}
// "19h00", "19:00", "19.00", "0645", "06h45", "7", "07hoo" -> minutes after midnight, or null
export function parseSheetTime(s) {
  let t = String(s ?? '').toLowerCase().trim().replace(/hours?|hrs?|uur|\b(am|pm)\b/g, ' ').replace(/[o]/g, '0').replace(/(\d)\s+(\d)(?=\s*[h:.])/g, '$1$2');   // "19-00", "19 00", "1 9h00", "07:00 hrs"
  t = t.replace(/[^0-9]+/g, ':').replace(/^:|:$/g, '');
  if (/^\d{3,4}$/.test(t)) t = t.length === 3 ? t[0] + ':' + t.slice(1) : t.slice(0, 2) + ':' + t.slice(2);
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t); if (!m) return null; const h = +m[1], mi = m[2] ? +m[2] : 0;
  return h > 24 || mi > 59 ? null : h * 60 + mi;
}
// "12h00", "12hrs", "12.00", "12", "1.5", "73,5" -> number of hours, or null
export function parseHoursWritten(v) {
  if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(?:h|hrs?|hs|hours?)?\s*(\d{2})?$/.exec(String(v).trim().toLowerCase().replace(/o/g, '0')); if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.')); return m[2] && /h/i.test(String(v)) ? n + (+m[2]) / 60 : n;
}
// hours between in and out; an out at or before the in is the next day (a night shift)
export function hoursBetween(inMin, outMin) { if (inMin == null || outMin == null) return null; let d = outMin - inMin; if (d <= 0) d += 1440; return Math.round((d / 60) * 100) / 100; }
// the shift a start time belongs to: starting before 12:00 is a day shift, otherwise a night shift
export const shiftOfStart = (inMin) => (inMin == null ? null : inMin < 12 * 60 ? 'day' : 'night');

// ---- normalise one scanned sheet -------------------------------------------------------------------------
// raw: { name, rank, month, rate, totalHours, totalAmount, managerSigned, shifts:[{date,in,out,hours,struck,managerSigned}] }
// opts: { rates: { RN: 99, EN: .., ENA: .. }, rankKey(rank) -> key }
export const RANK_KEYS = [[/h\s*\/?\s*c\s*\/?\s*w|health\s*care|healthcare|care\s*worker|care\s*giver/i, 'HCW'], [/^e\s*\/?\s*n\s*\/?\s*a|ena|enrolled nursing a|auxiliar/i, 'ENA'], [/^e\s*\/?\s*n$|enrolled\s*n|^en\b|^st\s*\/?\s*n\b|staff\s*nurse/i, 'EN'], [/^r\s*\/?\s*n$|^rn\b|registered|prof/i, 'RN']];
export function rankKey(rank) { const r = String(rank ?? '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim(); for (const [re, k] of RANK_KEYS) if (re.test(r)) return k; return null; }
export const money = (n) => Math.round(n * 100) / 100;

// year and month for dates written without them: from the lines that do have them, then the sheet's month heading, then the pay run
export function sheetDateContext(raw, win) {
  const live = (raw.shifts || []).filter((x) => !x.struck).map((x) => parseSheetDate(x.date)).filter(Boolean);
  const mode = (arr) => { const c = new Map(); for (const v of arr) c.set(v, (c.get(v) || 0) + 1); let best = null, n = 0; for (const [k, v] of c) if (v > n) { best = k; n = v; } return best; };
  const head = String(raw.month ?? ''); const hy = /(20\d{2})/.exec(head); const hm = monthFromText(head);
  const away = win && live.length && !live.some((d) => d >= win.start && d <= win.end);      // a sheet from another period: its own dates lead, not the pay run
  return { win: away ? null : (win || null), year: mode(live.map((d) => +d.slice(0, 4))) || (hy ? +hy[1] : null) || (win ? +win.start.slice(0, 4) : null), month: hm || mode(live.map((d) => +d.slice(5, 7))) || null };
}
export function normaliseSheet(raw, opts = {}) {
  const flags = []; const rows = [];
  const dateCtx = sheetDateContext(raw, opts.win);
  for (const s of raw.shifts || []) {
    const date = parseSheetDate(s.date, dateCtx), inMin = parseSheetTime(s.in), outMin = parseSheetTime(s.out);
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
  const sheetKey = rankKey(raw.rank); const personKey = rankKey(opts.personRank); const key = sheetKey || personKey; const table = opts.rates || {}; const expected = key && table[key] != null ? table[key] : null;
  const rate = raw.rate == null || raw.rate === '' ? null : Number(raw.rate);
  if (rate != null && expected != null && Math.abs(rate - expected) > 0.005) flags.push(`Rate on the form reads ${rate}; the ${key} rate in the system (${expected}) is used`);
  /* the system rate for the rank wins: a rate written on the form is often misread (58.80 read as 68.8, R99 as 209) */ const useRate = expected ?? rate; const amount = useRate != null ? money(sum * useRate) : null; const writtenAmount = raw.totalAmount == null ? null : Number(raw.totalAmount);
  if (amount != null && writtenAmount != null && Math.abs(amount - writtenAmount) > 0.5) flags.push(`Total amount written ${writtenAmount} but ${sum} hours at ${useRate} is ${amount}`);
  if (key == null) flags.push('Rank not recognised');
  else if (!sheetKey) flags.push(`Rank on the sheet ("${raw.rank || ''}") not recognised: using ${key} from the roster`);
  else if (personKey && personKey !== sheetKey) flags.push(`The sheet says ${sheetKey} but the roster has this person as ${personKey}; the sheet rank is used`);
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
// the employee number written on the register ("0019", "EMP0019", "19") against the roster person ids (EMP0019)
export function personByNumber(written, people) {
  const d = String(written ?? '').replace(/\D/g, ''); if (!d) return null; const n = parseInt(d, 10);
  const hit = people.filter((p) => { const x = String(p.id || '').replace(/\D/g, ''); return x && parseInt(x, 10) === n; }); return hit.length === 1 ? hit[0] : null;
}
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

// ---- draft roster built from accepted sheets, for days that have no roster yet ---------------------------------
// groups: { groupId: { cfg, periods } }; entries: saved timesheet entries ({ personId, name, shifts:[{date, shift}] }); win: { start, end }
// Only days not already covered by a period of that group are filled. Nothing is overwritten.
export function retroRoster({ groups, entries, win }) {
  const plans = []; const unplaced = []; let skippedCovered = 0;
  for (const [gid, g] of Object.entries(groups)) {
    const rows = g.cfg.people || []; const covered = coveredDays(g.periods || []); const secIds = (g.cfg.sections || []).map((x) => x.id); const placed = []; const names = new Set();
    for (const e of entries) {
      if (!rows.some((r) => r.personId === e.personId)) continue;
      for (const sh of e.shifts || []) {
        if (!sh.date || sh.date < win.start || sh.date > win.end) continue;
        if (covered.has(sh.date)) { skippedCovered++; continue; }
        const row = secIds.includes(sh.shift) ? rows.find((r) => r.personId === e.personId && r.sectionId === sh.shift) : null;
        if (!row) { unplaced.push({ name: e.name, date: sh.date, shift: sh.shift || '?', why: sh.shift ? `${e.name} has no ${sh.shift} row on the roster` : 'shift not day or night' }); continue; }
        placed.push({ rowId: row.id, date: sh.date }); names.add(e.name);
      }
    }
    if (!placed.length) continue;
    const days = []; for (let d = win.start; d <= win.end; d = addDays(d, 1)) if (!covered.has(d)) days.push(d);
    let seg = [];
    const flush = () => { if (!seg.length) return; const start = seg[0], end = seg[seg.length - 1]; const inSeg = placed.filter((x) => x.date >= start && x.date <= end);
      if (inSeg.length) { const n = daysBetween(start, end) + 1; const cells = Object.fromEntries(rows.map((r) => [r.id, '0'.repeat(n)]));
        for (const x of inSeg) { const i = daysBetween(start, x.date); const c = cells[x.rowId]; cells[x.rowId] = c.slice(0, i) + '1' + c.slice(i + 1); }
        plans.push({ groupId: gid, start, end, cells, shifts: inSeg.length, people: [...new Set(inSeg.map((x) => rows.find((r) => r.id === x.rowId).name))] }); }
      seg = []; };
    for (const d of days) { if (seg.length && (daysBetween(seg[seg.length - 1], d) !== 1 || seg.length >= 63)) flush(); seg.push(d); }
    flush();
  }
  return { plans, unplaced, skippedCovered };
}

// ---- adding a second sheet to hours already saved for a run; late claims are paid in the next run ------------
// existing/incoming: [{ date, shift, hours, extension }]. Lines already counted (same date, shift and extension) are skipped, so nothing is paid twice.
export function mergeShifts(existing, incoming, { late = false, payRun = null } = {}) {
  const key = (x) => `${x.date}|${x.shift || ''}|${x.extension ? 1 : 0}`; const have = new Set((existing || []).map(key)); const out = (existing || []).map((x) => ({ ...x })); let added = 0, skipped = 0;
  for (const x of incoming || []) { if (have.has(key(x))) { skipped++; continue; } have.add(key(x)); added++; out.push(late ? { ...x, late: true, payRun } : { ...x }); }
  out.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.shift || '').localeCompare(b.shift || ''));
  return { shifts: out, added, skipped, hours: money(out.reduce((a, x) => a + (Number(x.hours) || 0), 0)) };
}
// hours in an entry that are late claims (paid in the next run), and late hours from earlier entries that are paid in the run starting at runStart
export const lateHours = (entry) => money((entry.shifts || []).filter((x) => x.late).reduce((a, x) => a + (Number(x.hours) || 0), 0));
export const lateHoursPaidIn = (entries, runStart) => money(entries.reduce((a, e) => a + (e.shifts || []).filter((x) => x.late && x.payRun === runStart).reduce((b, x) => b + (Number(x.hours) || 0), 0), 0));
export const payHours = (entry) => money((Number(entry.hours) || 0) - lateHours(entry));

// Payment follows the form (owner rule, 2026-11-02): every line that is not struck is paid in the pay run being captured, whatever date is written on it.
// offRun lists the lines whose date is outside that run (or unreadable): shown as a note only, never left out of the amount.
export function payLines(sheet, period) { const inside = sheet.rows.filter((r) => !r.struck); const offRun = inside.filter((r) => !r.date || !inPeriod(r.date, period)); return { inside, outside: [], offRun, hours: money(inside.reduce((a, r) => a + r.hours, 0)) }; }
