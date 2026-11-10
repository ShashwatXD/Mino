import * as chrono from "chrono-node";

export interface TimeRef {
  phrase: string;
  start: number;
  end: number;
  label: string;
}

const DAY = 86_400_000;

function zonedParts(tz: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    min: get("minute"),
    s: get("second"),
  };
}

function offsetMinutes(tz: string, at: number): number {
  const p = zonedParts(tz, at);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

function startOfDay(tz: string, y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMinutes(tz, guess) * 60_000;
  return guess - offsetMinutes(tz, first) * 60_000;
}

function dayStartOf(tz: string, at: number): number {
  const p = zonedParts(tz, at);
  return startOfDay(tz, p.y, p.m, p.d);
}

export function formatDay(tz: string, at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(at));
}

export function formatStamp(tz: string, at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(at));
}

export function safeTimeZone(tz: unknown): string {
  if (typeof tz === "string" && tz.length > 0) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      // Fall through to the server's zone.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Builds a window from explicit YYYY-MM-DD dates, rejecting impossible or absurdly long ranges. */
export function rangeRef(from: string, to: string, tz: string): TimeRef | null {
  const parse = (s: string) => s.split("-").map(Number) as [number, number, number];
  const start = startOfDay(tz, ...parse(from));
  const end = startOfDay(tz, ...parse(to)) + DAY;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 400 * DAY) return null;
  const lastDay = end - DAY;
  const label = lastDay > start ? `${formatDay(tz, start)} to ${formatDay(tz, lastDay)}` : formatDay(tz, start);
  return { phrase: from === to ? from : `${from} to ${to}`, start, end, label };
}

/** Turns phrases like "last Tuesday" or "3 November" into absolute windows in the user's zone. */
export function resolveTimeRefs(text: string, now: number, tz: string): TimeRef[] {
  const reference = { instant: new Date(now), timezone: offsetMinutes(tz, now) };
  const found = chrono.parse(text, reference, { forwardDate: false });
  const refs: TimeRef[] = [];

  for (const result of found) {
    const s = result.start;
    if (!s.isCertain("day") && !s.isCertain("weekday") && !s.isCertain("month") && !/week|month|year|ago|yesterday|today/i.test(result.text)) {
      continue;
    }

    let at = result.date().getTime();
    // Questions in a chat refer to the past, so a bare date that lands ahead is last occurrence.
    if (dayStartOf(tz, at) > dayStartOf(tz, now)) {
      if (s.isCertain("month") && !s.isCertain("year")) {
        const p = zonedParts(tz, at);
        at = startOfDay(tz, p.y - 1, p.m, p.d);
      } else if (s.isCertain("weekday")) {
        at -= 7 * DAY;
      }
    }

    let start = dayStartOf(tz, at);
    let end = start + DAY;

    if (/\bweek\b/i.test(result.text)) {
      const p = zonedParts(tz, at);
      const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
      start = dayStartOf(tz, at - ((weekday + 6) % 7) * DAY);
      end = start + 7 * DAY;
    } else if (/\bmonth\b/i.test(result.text) || (s.isCertain("month") && !s.isCertain("day"))) {
      const p = zonedParts(tz, at);
      start = startOfDay(tz, p.y, p.m, 1);
      end = p.m === 12 ? startOfDay(tz, p.y + 1, 1, 1) : startOfDay(tz, p.y, p.m + 1, 1);
    }

    if (result.end) end = dayStartOf(tz, result.end.date().getTime()) + DAY;

    const lastDay = end - DAY;
    const label = lastDay > start ? `${formatDay(tz, start)} to ${formatDay(tz, lastDay)}` : formatDay(tz, start);
    refs.push({ phrase: result.text, start, end, label });
  }
  return refs;
}
