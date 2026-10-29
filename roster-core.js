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
