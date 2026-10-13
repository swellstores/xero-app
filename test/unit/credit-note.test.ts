import { describe, expect, it } from "vitest";
import { buildCreditNote } from "../../functions/lib/credit-note";
import type { XeroDocument } from "../../functions/lib/xero";

const invoice: XeroDocument = {
  id: "inv-1",
  number: "INV-0001",
  status: "PAID",
  reference: "1001",
  contactId: "contact-1",
  currency: "NZD",
  lineAmountTypes: "Exclusive",
  subTotal: 45,
  totalTax: 6.75,
  total: 51.75,
  amountPaid: 51.75,
  amountDue: 0,
  date: null,
  lineItems: [
    { Description: "Linen Tee", Quantity: 2, UnitAmount: 20, AccountCode: "200", TaxType: "OUTPUT2", LineAmount: 40, TaxAmount: 6 },
    { Description: "Shipping", Quantity: 1, UnitAmount: 5, AccountCode: "260", TaxType: "OUTPUT2", LineAmount: 5, TaxAmount: 0.75 },
  ],
};

describe("buildCreditNote", () => {
  it("repeats the invoice's lines for a full refund", () => {
    const built = buildCreditNote({ invoice, refundCents: 5175, earlierCents: 0, orderNumber: "1001" });
    expect(built.lineAmountTypes).toBe("Exclusive");
    expect(built.lines).toEqual([
      { Description: "Linen Tee", Quantity: 2, UnitAmount: 20, AccountCode: "200", TaxType: "OUTPUT2" },
      { Description: "Shipping", Quantity: 1, UnitAmount: 5, AccountCode: "260", TaxType: "OUTPUT2" },
    ]);
  });

  it("splits a partial refund over the invoice's accounts, with tax included", () => {
    const built = buildCreditNote({ invoice, refundCents: 1000, earlierCents: 0, orderNumber: "1001", taxNames: { OUTPUT2: "15% GST on Income" } });
    expect(built.lineAmountTypes).toBe("Inclusive");
    expect(built.lines).toEqual([
      { Description: "Refund for order 1001", Quantity: 1, UnitAmount: 8.89, AccountCode: "200", TaxType: "OUTPUT2" },
      { Description: "Refund for order 1001", Quantity: 1, UnitAmount: 1.11, AccountCode: "260", TaxType: "OUTPUT2" },
    ]);
  });

  it("refuses more than the invoice holds", () => {
    expect(() => buildCreditNote({ invoice, refundCents: 2000, earlierCents: 4000, orderNumber: "1001" })).toThrow(/more than the invoice total/);
  });
});
