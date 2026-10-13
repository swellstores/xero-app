import { describe, expect, it } from "vitest";
import { buildInvoice, simulate, toLineItem } from "../../functions/lib/invoice";
import type { BuildOptions } from "../../functions/lib/invoice";
import { Problem } from "../../functions/lib/problem";
import type { TaxRate } from "../../functions/lib/xero";
import * as orders from "../fixtures/orders";

const NZ_RATES: TaxRate[] = [
  { name: "15% GST on Income", taxType: "OUTPUT2", status: "ACTIVE", rate: 15, revenue: true },
  { name: "15% GST on Expenses", taxType: "INPUT2", status: "ACTIVE", rate: 15, revenue: false },
  { name: "Zero Rated", taxType: "ZERORATED", status: "ACTIVE", rate: 0, revenue: true },
  { name: "No GST", taxType: "NONE", status: "ACTIVE", rate: 0, revenue: true },
];

function options(extra: Partial<BuildOptions> = {}): BuildOptions {
  return { salesAccount: "200", shippingAccount: "260", separateTax: false, taxRates: NZ_RATES, settings: {}, ...extra };
}

function problem(run: () => unknown): Problem {
  try {
    run();
  } catch (err) {
    if (err instanceof Problem) {
      return err;
    }
    throw err;
  }
  throw new Error("Expected a Problem");
}

describe("buildInvoice", () => {
  it("keeps the store's prices before tax when Xero's rounding gives the total", () => {
    const built = buildInvoice(orders.simple, options());
    expect(built.layout.lineAmountTypes).toBe("Exclusive");
    expect(built.totalCents).toBe(5175);
    expect(built.layout.lines.map((line) => toLineItem(line, true))).toEqual([
      { Description: "Linen Tee - Natural / M\nSKU LT-NAT-M", Quantity: 2, UnitAmount: 20, AccountCode: "200", TaxType: "OUTPUT2" },
      { Description: "Shipping: NZ Post Courier", Quantity: 1, UnitAmount: 5, AccountCode: "260", TaxType: "OUTPUT2" },
    ]);
    expect(built.fallback?.lineAmountTypes).toBe("Inclusive");
    expect(built.taxNote).toBe("15% GST on Income");
    expect(built.reference).toBe("1001");
  });

  it("switches to amounts including tax when Xero's per-line rounding would be a cent off", () => {
    const built = buildInvoice(orders.oddCents, options());
    expect(built.layout.lineAmountTypes).toBe("Inclusive");
    expect(built.layout.lines.map((line) => line.cents)).toEqual([8622, 1437, 690]);
    expect(simulate(built.layout).total).toBe(10749);
    expect(built.fallback).toBeUndefined();
  });

  it("shows a discount on its line, so the unit price is the one the customer saw", () => {
    const built = buildInvoice(orders.discounted, options());
    expect(built.layout.lineAmountTypes).toBe("Exclusive");
    expect(toLineItem(built.layout.lines[0], true)).toMatchObject({ Quantity: 2, UnitAmount: 50, DiscountAmount: 10 });
    expect(simulate(built.layout).total).toBe(10350);
  });

  it("sends a store's prices including tax as they are", () => {
    const built = buildInvoice(orders.taxIncluded, options());
    expect(built.layout.lineAmountTypes).toBe("Inclusive");
    expect(toLineItem(built.layout.lines[0], true)).toMatchObject({ Quantity: 1, UnitAmount: 23, TaxType: "OUTPUT2" });
  });

  it("puts US sales tax on a line of its own, on the sales tax account", () => {
    const built = buildInvoice(orders.unitedStates, options({ separateTax: true, salesTaxAccount: "2200", salesAccount: "4000", shippingAccount: "4000" }));
    expect(built.layout.lineAmountTypes).toBe("NoTax");
    expect(built.layout.lines.map((line) => toLineItem(line, true))).toEqual([
      { Description: "Desk Lamp", Quantity: 1, UnitAmount: 100, AccountCode: "4000" },
      { Description: "Shipping: UPS Ground", Quantity: 1, UnitAmount: 10, AccountCode: "4000" },
      { Description: "Sales tax: CA Sales Tax", Quantity: 1, UnitAmount: 8.25, AccountCode: "2200" },
    ]);
    expect(built.contact).toMatchObject({ Name: "Johnson Design", FirstName: "Ava", LastName: "Johnson", ContactNumber: "6ad0000000000000000000c3" });
  });

  it("asks for a sales tax account when a US order was charged tax", () => {
    expect(problem(() => buildInvoice(orders.unitedStates, options({ separateTax: true }))).code).toBe("no_tax_account");
  });

  it("asks which 0 % rate to use when Xero has several", () => {
    const found = problem(() => buildInvoice(orders.untaxed, options()));
    expect(found.code).toBe("tax_rate_ambiguous");
    expect(found.message).toContain("Zero Rated, No GST");
  });

  it("uses the rate the settings name for a percentage", () => {
    const built = buildInvoice(orders.untaxed, options({ settings: { taxes: { rates: [{ rate: 0, tax_rate: "zero rated" }] } } }));
    expect(built.layout.lines[0].taxType).toBe("ZERORATED");
    expect(built.taxNote).toBe("Zero Rated");
  });

  it("gives a free line without a rate the order's main rate, where 0 % would be ambiguous", () => {
    const built = buildInvoice(orders.freeItem, options());
    expect(built.layout.lines.map((line) => [line.description.split("\n")[0], line.cents, line.taxType])).toEqual([
      ["Linen Tee - Natural / M", 4000, "OUTPUT2"],
      ["Sticker", 0, "OUTPUT2"],
      ["Shipping: NZ Post Courier", 500, "OUTPUT2"],
    ]);
  });

  it("describes the customer as a Xero contact", () => {
    const built = buildInvoice(orders.simple, options());
    expect(built.contact).toEqual({
      Name: "Olivia Moore",
      FirstName: "Olivia",
      LastName: "Moore",
      EmailAddress: "olivia@example.com",
      ContactNumber: "6ad0000000000000000000a1",
      Addresses: [{ AddressType: "POBOX", AddressLine1: "12 Ponsonby Road", City: "Auckland", Region: "Auckland", PostalCode: "1011", Country: "NZ" }],
      Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "+64 21 555 0101" }],
    });
    expect(built.contactKey).toBe("6ad0000000000000000000a1");
  });

  it("refuses an order whose parts do not add up to its total", () => {
    expect(problem(() => buildInvoice({ ...orders.simple, grand_total: 60 }, options())).code).toBe("total_mismatch");
  });

  it("refuses a draft order", () => {
    expect(problem(() => buildInvoice({ ...orders.simple, draft: true }, options())).code).toBe("draft");
  });
});

describe("toLineItem", () => {
  it("makes one line for the lot when no unit price multiplies back to the amount", () => {
    expect(toLineItem({ description: "Socks", quantity: 3, listCents: 1000, cents: 1000, accountCode: "200", taxType: "OUTPUT2", rate: 15 }, true)).toEqual({
      Description: "3 x Socks",
      Quantity: 1,
      UnitAmount: 10,
      AccountCode: "200",
      TaxType: "OUTPUT2",
    });
  });

  it("leaves the discount out where Xero takes none", () => {
    expect(toLineItem({ description: "Jacket", quantity: 2, listCents: 10000, cents: 9000, accountCode: "200", rate: 15 }, false)).toEqual({
      Description: "Jacket",
      Quantity: 2,
      UnitAmount: 45,
      AccountCode: "200",
    });
  });
});
