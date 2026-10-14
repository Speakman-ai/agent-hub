/**
 * Matches a standard 5-field cron expression (minute hour day-of-month month
 * day-of-week) against a moment in an IANA timezone. Used by schedules that
 * share one once-a-minute ticker instead of registering a node-cron task each.
 *
 * Supports `*`, `?`, lists, ranges, steps (`*\/15`, `1-30/5`) and month/day
 * names. Day-of-week accepts 0-7 (0 and 7 are Sunday). When both day fields are
 * restricted, a day matches if either does (classic cron semantics); a field
 * starting with `*` counts as unrestricted but its steps still filter.
 */

interface FieldSpec {
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS },
  { min: 0, max: 7, names: DAYS },
];

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseValue(raw: string, spec: FieldSpec): number | null {
  const named = spec.names?.[raw.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= spec.min && n <= spec.max ? n : null;
}

function parseField(raw: string, spec: FieldSpec): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) return null;
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined || range === undefined) return null;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) return null;
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === '*' || range === '?') {
      lo = spec.min;
      hi = spec.max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || a === undefined || b === undefined) return null;
      const av = parseValue(a, spec);
      const bv = parseValue(b, spec);
      if (av === null || bv === null || av > bv) return null;
      lo = av;
      hi = bv;
    } else {
      const v = parseValue(range, spec);
      if (v === null) return null;
      lo = v;
      // `5/10` means "from 5, every 10" up to the field max.
      hi = stepRaw !== undefined ? spec.max : v;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parses an expression, or returns null when it is not a valid 5-field cron. */
export function parseCron(expr: string): ParsedCron | null {
  if (typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(parts[i] as string, FIELDS[i] as FieldSpec);
    if (!s || s.size === 0) return null;
    sets.push(s);
  }
  const [minutes, hours, daysOfMonth, months, dowRaw] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const daysOfWeek = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  const dom = (parts[2] as string).trim();
  const dow = (parts[4] as string).trim();
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: !dom.startsWith('*') && !dom.startsWith('?'),
    dowRestricted: !dow.startsWith('*') && !dow.startsWith('?'),
  };
}

export function isValidCron(expr: unknown): expr is string {
  return typeof expr === 'string' && parseCron(expr) !== null;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Wall-clock fields of `now` in `timeZone`. Throws on an unknown zone. */
export function zonedParts(
  now: Date,
  timeZone: string,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  return {
    minute: Number(get('minute')),
    hour: hour === 24 ? 0 : hour,
    day: Number(get('day')),
    month: Number(get('month')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** True when the cron fires in the minute containing `now`, read in `timeZone`. */
export function cronMatches(expr: string | ParsedCron, now: Date, timeZone: string): boolean {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!cron) return false;
  let p: ReturnType<typeof zonedParts>;
  try {
    p = zonedParts(now, timeZone);
  } catch {
    return false;
  }
  if (!cron.minutes.has(p.minute) || !cron.hours.has(p.hour) || !cron.months.has(p.month)) {
    return false;
  }
  const domOk = cron.daysOfMonth.has(p.day);
  const dowOk = cron.daysOfWeek.has(p.weekday);
  // OR only when both day fields are restricted. A wildcard field (`*`, or a
  // stepped `*/2`) still filters by its expanded set; for a plain `*` that set
  // is every day, so ANDing it is a no-op.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}
