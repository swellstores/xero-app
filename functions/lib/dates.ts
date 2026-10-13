/**
 * Xero takes dates as days (YYYY-MM-DD) and keeps the books in the organisation's time
 * zone. An order placed at 23:30 UTC belongs to the next day in Auckland, and at a month's
 * end to the next month. Xero names the zone the Windows way; the zones of the countries
 * Xero is used in are mapped here, and anything else is taken as UTC.
 */

const ZONES: Record<string, string> = {
  NEWZEALANDSTANDARDTIME: "Pacific/Auckland",
  CHATHAMISLANDSSTANDARDTIME: "Pacific/Chatham",
  AUSEASTERNSTANDARDTIME: "Australia/Sydney",
  EAUSTRALIASTANDARDTIME: "Australia/Brisbane",
  TASMANIASTANDARDTIME: "Australia/Hobart",
  CENAUSTRALIASTANDARDTIME: "Australia/Adelaide",
  AUSCENTRALSTANDARDTIME: "Australia/Darwin",
  WAUSTRALIASTANDARDTIME: "Australia/Perth",
  LORDHOWESTANDARDTIME: "Australia/Lord_Howe",
  GMTSTANDARDTIME: "Europe/London",
  GREENWICHSTANDARDTIME: "Atlantic/Reykjavik",
  WEUROPESTANDARDTIME: "Europe/Berlin",
  ROMANCESTANDARDTIME: "Europe/Paris",
  CENTRALEUROPESTANDARDTIME: "Europe/Budapest",
  CENTRALEUROPEANSTANDARDTIME: "Europe/Warsaw",
  GTBSTANDARDTIME: "Europe/Bucharest",
  FLESTANDARDTIME: "Europe/Kiev",
  EEUROPESTANDARDTIME: "Europe/Chisinau",
  SOUTHAFRICASTANDARDTIME: "Africa/Johannesburg",
  EASTERNSTANDARDTIME: "America/New_York",
  CENTRALSTANDARDTIME: "America/Chicago",
  MOUNTAINSTANDARDTIME: "America/Denver",
  USMOUNTAINSTANDARDTIME: "America/Phoenix",
  PACIFICSTANDARDTIME: "America/Los_Angeles",
  ALASKANSTANDARDTIME: "America/Anchorage",
  HAWAIIANSTANDARDTIME: "Pacific/Honolulu",
  ATLANTICSTANDARDTIME: "America/Halifax",
  NEWFOUNDLANDSTANDARDTIME: "America/St_Johns",
  CANADACENTRALSTANDARDTIME: "America/Regina",
  USEASTERNSTANDARDTIME: "America/Indianapolis",
  SINGAPORESTANDARDTIME: "Asia/Singapore",
  CHINASTANDARDTIME: "Asia/Shanghai",
  TOKYOSTANDARDTIME: "Asia/Tokyo",
  INDIASTANDARDTIME: "Asia/Kolkata",
  ARABIANSTANDARDTIME: "Asia/Dubai",
  FIJISTANDARDTIME: "Pacific/Fiji",
  UTC: "UTC",
};

/** The IANA zone for Xero's name of it, or UTC */
export function zoneOf(xeroTimezone: string | undefined | null): string {
  const key = String(xeroTimezone || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return ZONES[key] || "UTC";
}

function asDate(value: Date | string | undefined | null): Date {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** The day of a moment in the given zone, as Xero takes it: 2026-10-13 */
export function xeroDay(value: Date | string | undefined | null, zone: string): string {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const part of format.formatToParts(asDate(value))) {
    parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Adds days to a YYYY-MM-DD day */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The due date of an invoice dated `day` under Xero's sales payment terms. Without terms the
 * invoice is due on its date, which is right for an order that is paid already.
 */
export function dueDate(day: string, terms: { day: number; type: string } | undefined): string {
  if (!terms || !Number.isFinite(terms.day)) {
    return day;
  }
  const [year, month] = day.split("-").map(Number);
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const inMonth = (y: number, m: number, d: number) => {
    const normal = new Date(Date.UTC(y, m - 1, 1));
    const capped = Math.min(Math.max(1, d), lastDay(normal.getUTCFullYear(), normal.getUTCMonth() + 1));
    return new Date(Date.UTC(normal.getUTCFullYear(), normal.getUTCMonth(), capped)).toISOString().slice(0, 10);
  };
  switch (terms.type) {
    case "DAYSAFTERBILLDATE":
      return addDays(day, terms.day);
    case "DAYSAFTERBILLMONTH":
      return addDays(inMonth(year, month, lastDay(year, month)), terms.day);
    case "OFCURRENTMONTH": {
      const due = inMonth(year, month, terms.day);
      return due < day ? day : due;
    }
    case "OFFOLLOWINGMONTH":
      return inMonth(year, month + 1, terms.day);
    default:
      return day;
  }
}
