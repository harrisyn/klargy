/**
 * Day and clock-time helpers. Every location has a timezone; "today", opening
 * hours and slot times are local to it, whatever timezone the server runs in.
 * Passing no timezone keeps the server's own (only for org-wide counters).
 */

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string) {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partsFormatter.set(tz, f);
  }
  return f;
}

export function validTimeZone(tz?: string | null): string | undefined {
  if (!tz) return undefined;
  try { formatterFor(tz); return tz; } catch { return undefined; }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(date: Date, tz: string) {
  const out: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
}

/** Milliseconds the timezone is ahead of UTC at that instant. */
function offsetMs(date: Date, tz: string) {
  const p = zonedParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the given local wall-clock time happens in tz. */
export function zonedTime(tz: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let result = guess - offsetMs(new Date(guess), tz);
  // Correct once more across a DST change between the guess and the result.
  const second2 = guess - offsetMs(new Date(result), tz);
  if (second2 !== result) result = second2;
  return new Date(result);
}

/** "10:30": the 24-hour wall-clock time of an instant in tz (UTC when tz is unknown). */
export function clockTime(date: Date, tz?: string | null): string {
  const p = zonedParts(new Date(date), validTimeZone(tz) ?? 'UTC');
  return `${String(p.hour % 24).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export const hourIn = (date: Date, tz?: string) => (tz ? zonedParts(date, tz).hour : date.getHours());
export const weekdayIn = (date: Date, tz?: string) => (tz ? zonedParts(date, tz).weekday : date.getDay());

export const parseTimeToDate = (timeStr: string, baseDate: Date, tz?: string): Date => {
  const [hours, minutes] = timeStr.split(':').map(Number);
  if (tz) {
    const p = zonedParts(baseDate, tz);
    return zonedTime(tz, p.year, p.month, p.day, hours, minutes);
  }
  const date = new Date(baseDate);
  date.setHours(hours, minutes, 0, 0);
  return date;
};

export const getStartOfDay = (date: Date = new Date(), tz?: string): Date => {
  if (tz) {
    const p = zonedParts(date, tz);
    return zonedTime(tz, p.year, p.month, p.day);
  }
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

export const getEndOfDay = (date: Date = new Date(), tz?: string): Date => {
  if (tz) {
    const p = zonedParts(date, tz);
    return zonedTime(tz, p.year, p.month, p.day, 23, 59, 59, 999);
  }
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

/** A calendar date ("2026-09-26") as the start of that day in tz. */
export const startOfLocalDate = (isoDate: string, tz?: string): Date => {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return tz ? zonedTime(tz, y, m, d) : new Date(y, m - 1, d);
};

export const isDayActive = (date: Date, activeDays: string, tz?: string): boolean => {
  const activeDaysArray = activeDays.split(',').map(Number);
  return activeDaysArray.includes(weekdayIn(date, tz));
};

export const generateTimeSlots = (
  startTime: string,
  endTime: string,
  slotDuration: number,
  baseDate: Date,
  tz?: string
): { startTime: Date; endTime: Date }[] => {
  const slots: { startTime: Date; endTime: Date }[] = [];
  const start = parseTimeToDate(startTime, baseDate, tz);
  const end = parseTimeToDate(endTime, baseDate, tz);

  let currentStart = new Date(start);
  while (currentStart < end) {
    const slotEnd = new Date(currentStart.getTime() + slotDuration * 60000);
    if (slotEnd <= end) {
      slots.push({
        startTime: new Date(currentStart),
        endTime: slotEnd,
      });
    }
    currentStart = slotEnd;
  }

  return slots;
};

export const formatDuration = (minutes: number): string => {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
};
