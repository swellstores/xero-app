/**
 * Decides which of an order's payments are recorded in Xero, and on which account.
 *
 * Xero takes a payment on a bank account, or on an account with payments enabled. Shop
 * payments usually reach the bank days later, as one payout of the payment provider, so
 * merchants record them on a clearing account and transfer the payouts from there. A single
 * payment method may go to another account, or be left for Xero's bank reconciliation. Gift
 * cards and store credit are no money arriving and are left alone unless the merchant names
 * an account for them.
 */

import { Problem } from "./problem";
import type { SwellRecord } from "./problem";
import { formatCents, toCents } from "./money";
import type { Settings } from "./settings";
import type { Account } from "./xero";

/** Methods that pay with value the customer already holds */
const NOT_MONEY = ["giftcard", "account"];

export interface Booking {
  method: string;
  cents: number;
  /** When the payment was made */
  date: string;
  /** The account's code or name, as the merchant wrote it */
  account: string;
  paymentId: string;
}

export interface BookingPlan {
  bookings: Booking[];
  /** Payments that are not recorded, because their method has no account */
  open: { method: string; cents: number }[];
}

function normal(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

/** The Xero account a payment method is recorded on, or nothing when it is left alone */
export function accountFor(settings: Settings, method: string | undefined | null): string | undefined {
  const key = normal(method);
  const exception = (settings.payments?.exceptions || []).find((row) => normal(row?.method) === key && key !== "");
  if (exception) {
    return (exception.account || "").trim() || undefined;
  }
  if (NOT_MONEY.includes(key)) {
    return undefined;
  }
  return (settings.payments?.account || "").trim() || undefined;
}

/** The order's successful payments in the order they were made, capped at the invoice total */
export function planBookings(payments: SwellRecord[], settings: Settings, totalCents: number): BookingPlan {
  const plan: BookingPlan = { bookings: [], open: [] };
  const paid = payments
    .filter((payment) => payment?.success === true && payment.captured !== false && !payment.void)
    .sort((a, b) => String(a.date_created || "").localeCompare(String(b.date_created || "")) || String(a.id).localeCompare(String(b.id)));
  let left = totalCents;

  for (const payment of paid) {
    const cents = Math.min(toCents(payment.amount), left);
    if (cents <= 0) {
      continue;
    }
    left -= cents;
    const method = String(payment.method || "");
    const account = accountFor(settings, method);
    if (account) {
      plan.bookings.push({ method, cents, date: String(payment.date_created || new Date().toISOString()), account, paymentId: String(payment.id) });
    } else {
      plan.open.push({ method, cents });
    }
  }
  return plan;
}

/** The account with this code or name. Throws what the merchant has to correct */
export function findAccount(accounts: Account[], wanted: string): Account | undefined {
  const key = normal(wanted);
  return (
    accounts.find((account) => account.status === "ACTIVE" && normal(account.code) === key && key !== "") ||
    accounts.find((account) => account.status === "ACTIVE" && normal(account.name) === key)
  );
}

/** The account a payment is recorded on, by its code or name. Throws what the merchant has to correct */
export function resolvePaymentAccount(accounts: Account[], wanted: string): Account {
  const account = findAccount(accounts, wanted);
  if (!account) {
    throw new Problem(
      "failed",
      "no_account",
      `Xero has no active account with the code or name "${wanted}", so the payment was not recorded. Correct it under Payments in the app's settings (Test connection lists the accounts that take payments), then retry.`,
    );
  }
  if (!account.takesPayments) {
    throw new Problem(
      "failed",
      "account_no_payments",
      `The Xero account "${account.code ? `${account.code} ` : ""}${account.name}" does not take payments. Name a bank account under Payments in the app's settings, or turn on "Enable payments to this account" for it in Xero's chart of accounts, then retry.`,
    );
  }
  return account;
}

/** What was done about the payments, for the merchant */
export function describeBooking(plan: BookingPlan, paidCents: number, totalCents: number, currency: string, hasAccount: boolean): string {
  const parts: string[] = [];
  if (paidCents >= totalCents && totalCents > 0) {
    parts.push("Paid in Xero.");
  } else if (paidCents > 0) {
    parts.push(`${formatCents(paidCents)} of ${formatCents(totalCents)} ${currency} recorded as paid in Xero.`);
  }
  if (plan.open.length > 0) {
    const methods = [...new Set(plan.open.map((entry) => entry.method || "unknown"))].join(", ");
    const cents = plan.open.reduce((sum, entry) => sum + entry.cents, 0);
    parts.push(
      hasAccount
        ? `Not recorded: ${formatCents(cents)} ${currency} paid by ${methods}, which has no Xero account in the app's settings.`
        : "Not recorded: no Xero account for payments is set in the app's settings.",
    );
  } else if (plan.bookings.length === 0 && paidCents < totalCents) {
    parts.push("Not recorded: the order has no payment yet.");
  }
  return parts.join(" ");
}
