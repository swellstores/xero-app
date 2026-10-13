import { describe, expect, it } from "vitest";
import { chooseTaxRate, describeTaxes } from "../../functions/lib/tax";
import type { TaxRate } from "../../functions/lib/xero";

const UK: TaxRate[] = [
  { name: "20% (VAT on Income)", taxType: "OUTPUT2", status: "ACTIVE", rate: 20, revenue: true },
  { name: "5% (VAT on Income)", taxType: "RROUTPUT", status: "ACTIVE", rate: 5, revenue: true },
  { name: "Zero Rated Income", taxType: "ZERORATEDOUTPUT", status: "ACTIVE", rate: 0, revenue: true },
  { name: "Exempt Income", taxType: "EXEMPTOUTPUT", status: "ACTIVE", rate: 0, revenue: true },
  { name: "Old 17.5%", taxType: "TAX001", status: "DELETED", rate: 17.5, revenue: true },
];

describe("chooseTaxRate", () => {
  it("takes the one active sales rate with the percentage", () => {
    expect(chooseTaxRate(20, UK, {})).toEqual({ taxType: "OUTPUT2", name: "20% (VAT on Income)", rate: 20 });
  });

  it("takes the merchant's choice by name or tax type, also for a percentage written with a comma", () => {
    expect(chooseTaxRate(0, UK, { taxes: { rates: [{ rate: "0,0", tax_rate: "zero rated income" }] } }).taxType).toBe("ZERORATEDOUTPUT");
    expect(chooseTaxRate(0, UK, { taxes: { rates: [{ rate: 0, tax_rate: "EXEMPTOUTPUT" }] } }).taxType).toBe("EXEMPTOUTPUT");
  });

  it("says what is missing, ambiguous or misnamed", () => {
    expect(() => chooseTaxRate(17.5, UK, {})).toThrow(/no active sales tax rate of 17\.5 %/);
    expect(() => chooseTaxRate(0, UK, {})).toThrow(/several sales tax rates of 0 %: Zero Rated Income, Exempt Income/);
    expect(() => chooseTaxRate(0, UK, { taxes: { rates: [{ rate: 0, tax_rate: "Zero" }] } })).toThrow(/no active sales tax rate named "Zero"/);
  });
});

describe("describeTaxes", () => {
  it("lists the percentages that need a choice, and names that Xero does not have", () => {
    expect(describeTaxes(UK, {})).toEqual([
      "Orders with 0 % need a choice under Tax rates, because Xero has several sales tax rates of 0 %: Zero Rated Income, Exempt Income.",
    ]);
    expect(describeTaxes(UK, { taxes: { rates: [{ rate: 0, tax_rate: "Exempt Income" }, { rate: 5, tax_rate: "Reduced" }] } })).toEqual([
      'Xero has no active sales tax rate named "Reduced".',
    ]);
  });
});
