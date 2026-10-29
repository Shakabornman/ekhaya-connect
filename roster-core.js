// roster-core.js: pure roster logic for Ekhaya Connect (no Firebase, no screens).
// Used by roster.html and by the tests. Dates are ISO strings (YYYY-MM-DD); a shift belongs to the date it STARTS.
export const SHIFT_HOURS = 12;
export const WEEK_WARN = 45;   // hours in a week: amber indicator
export const WEEK_ALERT = 55;  // hours in a week: red indicator (indicators only, nothing is blocked)

const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;                     // m is 1-12
export function parseISO(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
const toUTC = (s) => { const p = parseISO(s); return Date.UTC(p.y, p.m - 1, p.d); };
const fromUTC = (t) => { const d = new Date(t); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
export const addDays = (s, n) => fromUTC(toUTC(s) + n * 86400000);
export const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const dowMon0 = (s) => (new Date(toUTC(s)).getUTCDay() + 6) % 7;         // Monday = 0 ... Sunday = 6
export const weekStart = (s) => addDays(s, -dowMon0(s));                          // Monday of the week containing s
const floorDiv = (a, b) => Math.floor(a / b);

// ---- config versions: the version in force on a date is the one with the latest validFrom on or before it
export function versionFor(config, dateISO) {
  const vs = (config.versions || []).filter((v) => v.validFrom <= dateISO).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return vs.length ? vs[vs.length - 1] : null;
}

// ---- pattern engine "two-pair-8wk": one dedicated day guard plus two pairs that swap roles every 2-week cycle; repeats every 8 weeks.
export function generateDay(version, dateISO) {
  const i = daysBetween(version.anchor, dateISO); const wk = floorDiv(i, 7); const cyc = floorDiv(wk, 2); const dow = ((i % 7) + 7) % 7;
  const A = version.pairA, B = version.pairB; const [X, Y] = ((cyc % 2) + 2) % 2 === 0 ? [A, B] : [B, A];
  let day, night;
  const evenWeek = (((wk % 2) + 2) % 2) === 0;
  if (evenWeek) { night = dow <= 3 ? Y : X; day = dow <= 4 ? [version.dayGuard] : [...Y]; }
  else {
    night = dow <= 1 ? Y : dow <= 3 ? X : Y; day = [version.dayGuard];
    if (dow >= 5) day.push(X[(((floorDiv(cyc, 2)) % 2) + 2) % 2]);
  }
  return { day: [...day], night: [...night], cycleWeek: evenWeek ? 'Week 2' : 'Week 1' };
}

// ---- generated roster + overrides = effective roster
// overrides: { id, date, shift:'day'|'night', outPersonId, inPersonId|null, reason, note, cancelled, swapGroupId }
export function effectiveRoster(config, overrides, fromISO, toISO) {
  const active = (overrides || []).filter((o) => !o.cancelled);
  const out = [];
  for (let d = fromISO; d <= toISO; d = addDays(d, 1)) {
    const v = versionFor(config, d);
    if (!v) { out.push({ date: d, dow: dowMon0(d), noConfig: true, day: { slots: [], gaps: [], expected: 0 }, night: { slots: [], gaps: [], expected: 0 } }); continue; }
    const g = generateDay(v, d);
    const row = { date: d, dow: dowMon0(d), cycleWeek: g.cycleWeek };
    for (const shift of ['day', 'night']) {
      const slots = g[shift].map((pid) => ({ personId: pid, originalPersonId: null, overrideId: null, reason: null, note: '' }));
      const gaps = []; const expected = g[shift].length;
      for (const o of active.filter((x) => x.date === d && x.shift === shift)) {
        const idx = slots.findIndex((s) => s.personId === o.outPersonId && s.overrideId === null);
        if (idx < 0) continue;                                              // the person was not rostered: ignore a stale override
        if (o.inPersonId) slots[idx] = { personId: o.inPersonId, originalPersonId: o.outPersonId, overrideId: o.id || null, reason: o.reason, note: o.note || '' };
        else { slots.splice(idx, 1); gaps.push({ originalPersonId: o.outPersonId, overrideId: o.id || null, reason: o.reason, note: o.note || '' }); }
      }
      row[shift] = { slots, gaps, expected };
    }
    row.shortDay = row.day.slots.length < row.day.expected; row.shortNight = row.night.slots.length < row.night.expected;
    out.push(row);
  }
  return out;
}

// ---- warnings (never blocking) when someone is put on a shift
export function conflictsForIn(rows, personId, dateISO, shift) {
  const by = Object.fromEntries(rows.map((r) => [r.date, r]));
  const works = (d, s) => !!by[d] && by[d][s].slots.some((x) => x.personId === personId);
  const msgs = [];
  if (shift === 'day') { if (works(addDays(dateISO, -1), 'night')) msgs.push('works the night before and finishes at 07:00, when this day shift starts'); if (works(dateISO, 'night')) msgs.push('is also on the night shift the same date'); }
  if (shift === 'night') { if (works(dateISO, 'day')) msgs.push('is also on the day shift the same date'); if (works(addDays(dateISO, 1), 'day')) msgs.push('is on the day shift the next morning, straight after this night'); }
  return msgs;
}

// ---- hours: a shift counts for the person who worked it, in the period containing its start date
export function hoursSummary(rows, fromISO, toISO) {
  const m = {}; const get = (p) => (m[p] ||= { day: 0, night: 0, shifts: 0, hours: 0, sick: 0, absent: 0, leave: 0 });
  for (const r of rows) {
    if (r.date < fromISO || r.date > toISO) continue;
    for (const shift of ['day', 'night']) {
      for (const s of r[shift].slots) { const a = get(s.personId); a[shift]++; a.shifts++; a.hours += SHIFT_HOURS; }
      const offs = [...r[shift].gaps, ...r[shift].slots.filter((s) => s.originalPersonId).map((s) => ({ originalPersonId: s.originalPersonId, reason: s.reason }))];
      for (const g of offs) { const a = get(g.originalPersonId); if (g.reason === 'sick') a.sick++; else if (g.reason === 'absent') a.absent++; else if (g.reason === 'leave') a.leave++; }
    }
  }
  return m;
}

// hours per person per week (Monday to Sunday), by shift start date
export function weeklyHours(rows, weekStarts) {
  const res = {}; for (const w of weekStarts) res[w] = {};
  for (const r of rows) { const w = weekStart(r.date); if (!(w in res)) continue; for (const shift of ['day', 'night']) for (const s of r[shift].slots) res[w][s.personId] = (res[w][s.personId] || 0) + SHIFT_HOURS; }
  return res;
}
export const weekLevel = (h) => (h > WEEK_ALERT ? 'alert' : h > WEEK_WARN ? 'warn' : 'ok');
export function weekStartsOverlapping(fromISO, toISO) { const out = []; for (let w = weekStart(fromISO); w <= toISO; w = addDays(w, 7)) out.push(w); return out; }

// ---- pay periods (the payroll app pays hourly "Two Weekly" staff on the 15th and at month end)
export function periodsForMonth(y, m) {
  const last = daysInMonth(y, m);
  return [{ key: 'month', label: 'Whole month', from: iso(y, m, 1), to: iso(y, m, last) }, { key: 'first', label: '1st to 15th', from: iso(y, m, 1), to: iso(y, m, 15) }, { key: 'second', label: `16th to ${last}th`, from: iso(y, m, 16), to: iso(y, m, last) }];
}

// ---- CSV for the payroll hours sheet
export const CSV_COLUMNS = ['periodStart', 'periodEnd', 'employeeNumber', 'name', 'type', 'dayShifts', 'nightShifts', 'totalShifts', 'totalHours', 'sickShifts', 'absentShifts', 'leaveShifts'];
export function csvEscape(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
export function buildCsv(rowsOut) { return [CSV_COLUMNS.join(','), ...rowsOut.map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c])).join(','))].join('\r\n') + '\r\n'; }

// =====================================================================================================
// Manual grid rosters (nursing "Off Duty"). A person is either on or off duty each day; the section a row sits in
// (day or night) decides the shift and its hours. A roster period stores, for every row, one character per day:
// '1' = on duty, '0' = off duty, starting at the period's start date.
// config.people rows: { id: rowId, personId, name, rank, sectionId, employeeId, active }
// config.sections:   [{ id, label, shift: 'day'|'night', onCode, offCode, hours }]
// =====================================================================================================
export function periodDays(start, end) { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; }
export const periodLength = (p) => daysBetween(p.start, p.end) + 1;
export function cellOn(period, rowId, dateISO) { const i = daysBetween(period.start, dateISO); const s = (period.cells || {})[rowId]; return !!s && i >= 0 && i < s.length && s[i] === '1'; }
export function setCellString(period, rowId, dateISO, on) {
  const n = periodLength(period); const i = daysBetween(period.start, dateISO); if (i < 0 || i >= n) return (period.cells || {})[rowId] || '0'.repeat(n);
  const cur = ((period.cells || {})[rowId] || '').padEnd(n, '0').slice(0, n).split(''); cur[i] = on ? '1' : '0'; return cur.join('');
}
export const emptyCells = (rows, n) => Object.fromEntries(rows.map((r) => [r.id, '0'.repeat(n)]));
export function periodsOverlap(a, b) { return a.start <= b.end && b.start <= a.end; }
export function nextPeriodStart(periods) { if (!periods.length) return null; return addDays(periods.map((p) => p.end).sort().pop(), 1); }

// every (row, date) that is on duty in the given periods, as a Map rowId -> Set(dates)
export function onDutyMap(periods) {
  const m = new Map();
  for (const p of [...periods].sort((a, b) => a.start.localeCompare(b.start))) {
    for (const [rowId, str] of Object.entries(p.cells || {})) { if (!m.has(rowId)) m.set(rowId, new Set()); const set = m.get(rowId); for (let i = 0; i < str.length; i++) { const d = addDays(p.start, i); if (str[i] === '1') set.add(d); else set.delete(d); } }
  }
  return m;
}
const sectionOf = (config, row) => (config.sections || []).find((s) => s.id === row.sectionId) || { shift: 'day', hours: SHIFT_HOURS };
// per person (all of their rows added together) between two dates, counted by shift start date
export function gridSummary(config, periods, fromISO, toISO) {
  const on = onDutyMap(periods); const res = {};
  for (const row of config.people || []) {
    const sec = sectionOf(config, row); const a = (res[row.personId] ||= { name: row.name, rank: row.rank, day: 0, night: 0, shifts: 0, hours: 0 });
    for (const d of on.get(row.id) || []) if (d >= fromISO && d <= toISO) { a[sec.shift]++; a.shifts++; a.hours += sec.hours || SHIFT_HOURS; }
  }
  return res;
}
export function rowShiftCount(config, periods, rowId, fromISO, toISO) { const on = onDutyMap(periods).get(rowId) || new Set(); let n = 0; for (const d of on) if (d >= fromISO && d <= toISO) n++; return n; }
export function coverCount(config, periods, sectionId, dateISO) { const on = onDutyMap(periods); let n = 0; for (const row of config.people || []) if (row.sectionId === sectionId && row.active !== false && (on.get(row.id) || new Set()).has(dateISO)) n++; return n; }
export function gridWeeklyHours(config, periods, weekStarts) {
  const on = onDutyMap(periods); const res = Object.fromEntries(weekStarts.map((w) => [w, {}]));
  for (const row of config.people || []) { const sec = sectionOf(config, row); for (const d of on.get(row.id) || []) { const w = weekStart(d); if (w in res) res[w][row.personId] = (res[w][row.personId] || 0) + (sec.hours || SHIFT_HOURS); } }
  return res;
}
// what changed between two cell strings, for the audit trail: [{ date, from, to }]
export function diffCells(start, before, after) { const out = []; const n = Math.max((before || '').length, (after || '').length); for (let i = 0; i < n; i++) { const a = (before || '')[i] || '0', b = (after || '')[i] || '0'; if (a !== b) out.push({ date: addDays(start, i), from: a === '1' ? 'on' : 'off', to: b === '1' ? 'on' : 'off' }); } return out; }
