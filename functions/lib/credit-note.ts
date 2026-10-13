/**
 * Builds the credit note for a refund from the invoice it refunds.
 *
 * A refund in Swell is an amount and names no items. A refund of the whole invoice repeats
 * the invoice's lines. A partial refund becomes one line per account and tax rate of the
 * invoice, split in proportion to what the invoice holds on each, with amounts that include
 * tax so the credit note's total is the refund to the cent.
 */

import { allocate, formatCents, toCents } from "./money";
import { Problem } from "./problem";
import type { LineItem, XeroDocument } from "./xero";

export interface BuiltCreditNote {
  lineAmountTypes: "Exclusive" | "Inclusive" | "NoTax";
  lines: LineItem[];
  totalCents: number;
}

export interface CreditNoteSource {
  invoice: XeroDocument;
  refundCents: number;
  /** What the app credited on the invoice before, in cents */
  earlierCents: number;
  orderNumber: string;
  /** Tax rate names by tax type, for the line descriptions */
  taxNames?: Record<string, string>;
}

function lineItemFor(description: string, quantity: number, cents: number, accountCode: string, taxType?: string): LineItem {
  const unitMicros = Math.round((cents * 100) / quantity);
  const exact = unitMicros * quantity === cents * 100;
  return {
    Description: exact || quantity === 1 ? description : `${quantity} x ${description}`.slice(0, 4000),
    Quantity: exact ? quantity : 1,
    UnitAmount: (exact ? unitMicros : cents * 100) / 10000,
    AccountCode: accountCode,
    ...(taxType ? { TaxType: taxType } : {}),
  };
}

export function buildCreditNote(source: CreditNoteSource): BuiltCreditNote {
  const { invoice, refundCents, earlierCents, orderNumber } = source;
  const invoiceCents = toCents(invoice.total);
  if (refundCents <= 0) {
    throw new Problem("skipped", "no_amount", "The refund has no amount.");
  }
  if (refundCents + earlierCents > invoiceCents) {
    throw new Problem(
      "failed",
      "refund_exceeds",
      `The refund of ${formatCents(refundCents)} ${invoice.currency} and the earlier credit notes of ${formatCents(earlierCents)} ${invoice.currency} come to more than the invoice total of ${formatCents(invoiceCents)} ${invoice.currency}. Create this credit note in Xero by hand.`,
    );
  }
  const noTax = invoice.lineAmountTypes === "NoTax";

  if (refundCents === invoiceCents && earlierCents === 0) {
    // The whole invoice: the same lines, at the amounts after discount
    return {
      lineAmountTypes: invoice.lineAmountTypes as BuiltCreditNote["lineAmountTypes"],
      lines: invoice.lineItems
        .filter((line) => toCents(line.LineAmount) !== 0)
        .map((line) => lineItemFor(line.Description || `Refund for order ${orderNumber}`, line.Quantity || 1, toCents(line.LineAmount), line.AccountCode, noTax ? undefined : line.TaxType)),
      totalCents: refundCents,
    };
  }

  // Part of it: one line per account and tax rate, in proportion to the invoice
  const groups = new Map<string, { accountCode: string; taxType?: string; cents: number }>();
  for (const line of invoice.lineItems) {
    const gross = toCents(line.LineAmount) + (invoice.lineAmountTypes === "Exclusive" ? toCents(line.TaxAmount) : 0);
    const taxType = noTax ? undefined : line.TaxType;
    const key = `${line.AccountCode}|${taxType || ""}`;
    const group = groups.get(key) || { accountCode: line.AccountCode, taxType, cents: 0 };
    group.cents += gross;
    groups.set(key, group);
  }
  const shares = [...groups.values()].filter((group) => group.cents > 0);
  if (shares.length === 0) {
    throw new Problem("failed", "invoice_empty", "The invoice has no lines with an amount, so the refund cannot be split over them. Create this credit note in Xero by hand.");
  }
  const parts = allocate(refundCents, shares.map((group) => group.cents));
  const taxTypes = new Set(shares.map((group) => group.taxType || ""));
  const lines = shares
    .map((group, index) => {
      const name = group.taxType ? source.taxNames?.[group.taxType] || group.taxType : undefined;
      const description = taxTypes.size > 1 && name ? `Refund for order ${orderNumber}, ${name}` : `Refund for order ${orderNumber}`;
      return { cents: parts[index], item: lineItemFor(description, 1, parts[index], group.accountCode, group.taxType) };
    })
    .filter((line) => line.cents > 0)
    .map((line) => line.item);

  return { lineAmountTypes: noTax ? "NoTax" : "Inclusive", lines, totalCents: refundCents };
}
