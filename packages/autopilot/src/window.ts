/** The schedule part of a person's Autopilot settings. */
export interface AutopilotWindow {
  timezone: string;
  /** Minutes after local midnight; the window may wrap past midnight. */
  startMinute: number;
  endMinute: number;
  /** ISO weekdays (1 = Monday … 7 = Sunday) on which a window may start. */
  days: number[];
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local wall-clock parts of `at` in `tz`. */
function local(at: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    weekday: WEEKDAY[parts.weekday!]!,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    // The same wall-clock time read as UTC; minus `at` gives the zone's offset.
    asUtc: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)),
  };
}

/** The instant of local wall-clock `minute` on the local day of `at`, plus `dayShift` days. */
function atLocalMinute(at: Date, tz: string, minute: number, dayShift: number): Date {
  const l = local(at, tz);
  // Whole minutes, so the same window computed twice gives exactly the same instants.
  const offset = Math.round((l.asUtc - at.getTime()) / 60_000) * 60_000;
  const localMidnight = l.asUtc - (l.minute * 60_000 + (l.asUtc % 60_000));
  return new Date(localMidnight + dayShift * 86_400_000 + minute * 60_000 - offset);
}

export const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * The window `at` falls in, or null. A window that wraps midnight (19:00 → 07:00) belongs to the
 * day it started on, so Friday night's window runs into Saturday morning, and Saturday has none.
 */
export function currentWindow(w: AutopilotWindow, at: Date): { start: Date; end: Date } | null {
  const l = local(at, w.timezone);
  const wraps = w.startMinute > w.endMinute;
  if (!wraps) {
    if (l.minute >= w.startMinute && l.minute < w.endMinute && w.days.includes(l.weekday))
      return { start: atLocalMinute(at, w.timezone, w.startMinute, 0), end: atLocalMinute(at, w.timezone, w.endMinute, 0) };
    return null;
  }
  if (l.minute >= w.startMinute && w.days.includes(l.weekday)) return { start: atLocalMinute(at, w.timezone, w.startMinute, 0), end: atLocalMinute(at, w.timezone, w.endMinute, 1) };
  const yesterday = l.weekday === 1 ? 7 : l.weekday - 1;
  if (l.minute < w.endMinute && w.days.includes(yesterday)) return { start: atLocalMinute(at, w.timezone, w.startMinute, -1), end: atLocalMinute(at, w.timezone, w.endMinute, 0) };
  return null;
}

/** When the next window starts (for "Next run: tonight at 19:00"), looking up to 8 days ahead. */
export function nextWindowStart(w: AutopilotWindow, at: Date): Date | null {
  if (!w.days.length) return null;
  for (let d = 0; d <= 8; d++) {
    const start = atLocalMinute(at, w.timezone, w.startMinute, d);
    if (start.getTime() <= at.getTime()) continue;
    if (w.days.includes(local(start, w.timezone).weekday)) return start;
  }
  return null;
}

/** The next time the local clock reads `minute` (for "Run until morning": until the window's end time). */
export function nextLocalTime(tz: string, minute: number, at: Date): Date {
  const today = atLocalMinute(at, tz, minute, 0);
  return today.getTime() > at.getTime() + 60 * 60_000 ? today : atLocalMinute(at, tz, minute, 1);
}
