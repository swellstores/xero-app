import { describe, expect, it } from "vitest";
import { dueDate, xeroDay, zoneOf } from "../../functions/lib/dates";

describe("dates", () => {
  it("takes the day in the organisation's time zone", () => {
    expect(xeroDay("2026-10-12T22:30:00.000Z", zoneOf("NEWZEALANDSTANDARDTIME"))).toBe("2026-10-13");
    expect(xeroDay("2026-10-13T03:00:00.000Z", zoneOf("PACIFICSTANDARDTIME"))).toBe("2026-10-12");
    expect(xeroDay("2026-10-12T22:30:00.000Z", zoneOf("SOMEWHERESTANDARDTIME"))).toBe("2026-10-12");
  });

  it("follows Xero's sales payment terms", () => {
    expect(dueDate("2026-10-13", undefined)).toBe("2026-10-13");
    expect(dueDate("2026-10-13", { day: 20, type: "OFFOLLOWINGMONTH" })).toBe("2026-11-20");
    expect(dueDate("2026-01-31", { day: 31, type: "OFFOLLOWINGMONTH" })).toBe("2026-02-28");
    expect(dueDate("2026-10-13", { day: 14, type: "DAYSAFTERBILLDATE" })).toBe("2026-10-27");
    expect(dueDate("2026-10-13", { day: 7, type: "DAYSAFTERBILLMONTH" })).toBe("2026-11-07");
    expect(dueDate("2026-10-13", { day: 25, type: "OFCURRENTMONTH" })).toBe("2026-10-25");
    expect(dueDate("2026-10-28", { day: 25, type: "OFCURRENTMONTH" })).toBe("2026-10-28");
  });
});
