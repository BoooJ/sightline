import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDuration, formatMoney } from "./format";

describe("format", () => {
  it("durée", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(3725)).toBe("62:05");
  });
  it("argent", () => {
    expect(formatMoney(4750)).toBe("$4 750");
    expect(formatMoney(800)).toBe("$800");
  });
  it("date seule sans décalage de fuseau", () => {
    expect(formatDate("2026-09-01")).toContain("01");
    expect(formatDate("2026-09-01")).toContain("sept");
    expect(formatDate(null)).toBe("—");
  });
  it("date et heure : ISO naïf lu comme UTC", () => {
    const naive = formatDateTime("2026-09-01T10:30:00");
    expect(naive).toBe(formatDateTime("2026-09-01T10:30:00Z"));
    expect(naive).toContain("sept");
    expect(naive).toMatch(/\d{2}:\d{2}/);
    expect(formatDateTime(null)).toBe("—");
  });
});
