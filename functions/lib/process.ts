/**
 * Creates documents in Xero, one step at a time, with the ledger record as the state.
 *
 *   claim the record → contact → draft → check the total → approve → record the payments
 *
 * Every step is saved before the next begins, so any caller (a store event, a dashboard
 * action, the bulk workflow, a retry of any of them) can pick a record up where the last
 * attempt stopped. What keeps a step from happening twice:
 * - a record that is being worked on is locked, and of several attempts that start at the
 *   same moment only one gets it
 * - everything uncertain happens on a draft, which can be deleted. Before the create call
 *   the record is marked as submitted; a record still marked on a later attempt means the
 *   answer never came, and the draft is looked for in Xero by its reference before it is
 *   sent again. Sent again, it carries the same idempotency key, which Xero remembers for
 *   a few minutes
 * - approving an approved document changes nothing
 * - before a payment is recorded, the app reads what Xero already holds as paid
 *
 * One document is several calls to Xero and can take longer than a function may run, so
 * the work is done in workflow steps (functions/process-documents.ts). The functions that
 * receive the store's events only write the record and start a run.
 */

import { raiseAlert, settleAlerts } from "./alerts";
import { buildCreditNote } from "./credit-note";
import { dueDate, xeroDay, zoneOf } from "./dates";
import { claim, creditNoteKey, describe, findByKey, invoiceKey, provisionalName, save, take } from "./documents";
import type { DocumentRecord, XeroStatus } from "./documents";
import { buildInvoice, checkOrder, toLineItem } from "./invoice";
import type { BuildOptions, BuiltInvoice, Layout } from "./invoice";
import { formatCents, toCents } from "./money";
import { accountFor, describeBooking, findAccount, planBookings, resolvePaymentAccount } from "./payments";
import { Problem } from "./problem";
import type { SwellRecord } from "./problem";
import { approves, credentials, creditNotesEnabled } from "./settings";
import type { Settings, StoreClient } from "./settings";
import {
  XeroError,
  approve,
  createContact,
  createDocument,
  createPayment,
  deleteDraft,
  documentLink,
  findContacts,
  findDocuments,
  getAccounts,
  getContact,
  getDocument,
  getOrganisation,
  getTaxRates,
} from "./xero";
import type { Account, Api, CreditNoteInput, InvoiceInput, Organisation, TaxRate, XeroDocument, XeroDocumentStatus } from "./xero";

// Longer than a run takes when Xero is slow. A run that dies leaves the record locked for
// this long, then the next attempt takes it
const LOCK_MS = 2 * 60 * 1000;
// Xero may finish a request after the app stopped waiting for it
const SETTLE_MS = 60 * 1000;
// The app's payments carry this at the start of their reference, which tells them apart from
// payments the merchant records in Xero
const PAYMENT_REFERENCE = "Swell order ";

type Kind = "Invoice" | "CreditNote";

export interface Context {
  swell: StoreClient;
  settings: Settings;
  /** Approve the document although the settings say drafts: the merchant chose it for this one */
  approve?: boolean;
  /** Look at the order's payments again, also for an invoice whose payments were dealt with */
  rebook?: boolean;
  /** Orders read while their record was claimed, by id */
  orders?: Record<string, SwellRecord>;
  now?: () => Date;
}

export type Result =
  /** The document is in Xero and everything after it is done */
  | "created"
  /** It was complete already */
  | "exists"
  /** Another attempt is working on it right now */
  | "busy"
  /** It needs the merchant. The record says why */
  | "failed"
  /** The app does not handle this order */
  | "skipped"
  /** Xero could not be reached or is busy. The same attempt can succeed later */
  | "retry";

export interface Outcome {
  doc: DocumentRecord;
  result: Result;
  message: string;
}

function lock(from: Date): Partial<DocumentRecord> {
  return { locked_until: new Date(from.getTime() + LOCK_MS).toISOString(), date_attempted: from.toISOString() };
}

/** What a new record starts with: waiting since now, and locked when the caller works on it at once */
function attempt(from: Date, locked: boolean): Partial<DocumentRecord> {
  return { date_attempted: from.toISOString(), date_pending: from.toISOString(), ...(locked ? lock(from) : {}) };
}

function now(ctx: Context): Date {
  return ctx.now ? ctx.now() : new Date();
}

function api(ctx: Context): Api {
  return credentials(ctx.settings);
}

function kindOf(doc: DocumentRecord): Kind {
  return doc.type === "invoice" ? "Invoice" : "CreditNote";
}

function wantsApproved(ctx: Context): boolean {
  return ctx.approve === true || approves(ctx.settings);
}

function statusName(status: XeroDocumentStatus): XeroStatus {
  return String(status || "DRAFT").toLowerCase() as XeroStatus;
}

function isDraft(status: XeroStatus | XeroDocumentStatus | null | undefined): boolean {
  return !status || /^(draft|submitted)$/i.test(status);
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isComplete(ctx: Context, doc: DocumentRecord): boolean {
  if (doc.status !== "created" || !doc.xero_id) {
    return false;
  }
  // A draft is read again each time: the merchant may have approved or deleted it in Xero
  if (isDraft(doc.xero_status)) {
    return false;
  }
  return Boolean(doc.date_booked) && !(ctx.rebook && doc.type === "invoice" && toCents(doc.booked_amount) < toCents(doc.amount));
}

/** False for a record that has nothing left to do */
export function needsWork(ctx: Context, doc: DocumentRecord): boolean {
  return doc.status !== "resolved" && !isComplete(ctx, doc);
}

function organisation(ctx: Context): Promise<Organisation> {
  return getOrganisation(api(ctx));
}

/** An account for invoice lines, by its code or name. Throws what the merchant has to correct */
function lineAccount(accounts: Account[], wanted: string | null | undefined, setting: string, example: string): string {
  const name = (wanted || "").trim();
  if (!name) {
    throw new Problem("failed", "no_account", `Name the Xero account for ${setting} in the app's settings (${example}), then retry.`);
  }
  const account = findAccount(accounts, name);
  if (!account || !account.code || account.type === "BANK") {
    throw new Problem(
      "failed",
      "no_account",
      `Xero has no active account with the code or name "${name}" that invoices can use, which the app's settings name for ${setting}. Correct it (Test connection lists the accounts), then retry.`,
    );
  }
  return account.code;
}

async function buildOptions(ctx: Context): Promise<BuildOptions> {
  const [org, accounts, taxRates] = await Promise.all([organisation(ctx), getAccounts(api(ctx)), getTaxRates(api(ctx))]);
  const invoices = ctx.settings.invoices || {};
  const salesAccount = lineAccount(accounts, invoices.sales_account, "sales, under Invoices", "for example 200 Sales");
  const separateTax = org.countryCode === "US";
  const taxAccount = ctx.settings.taxes?.sales_tax_account;
  return {
    salesAccount,
    shippingAccount: (invoices.shipping_account || "").trim()
      ? lineAccount(accounts, invoices.shipping_account, "shipping, under Invoices", "or leave it empty to use the sales account")
      : salesAccount,
    separateTax,
    ...(separateTax && (taxAccount || "").trim()
      ? { salesTaxAccount: lineAccount(accounts, taxAccount, "sales tax, under Tax rates", "for example your Sales Tax Payable account") }
      : {}),
    taxRates,
    settings: ctx.settings,
  };
}

/** The app's own document among the contact's, recognised by the reference it carries */
async function findSubmitted(ctx: Context, kind: Kind, contactId: string, reference: string): Promise<XeroDocument | undefined> {
  const found = await findDocuments(api(ctx), kind, contactId, reference);
  return found[0];
}

/**
 * Creates the draft, or finds the one an earlier attempt created without learning of it.
 * `details` are saved with the mark, in one write.
 */
async function submit(
  ctx: Context,
  doc: DocumentRecord,
  kind: Kind,
  input: InvoiceInput | CreditNoteInput,
  details: Partial<DocumentRecord>,
): Promise<XeroDocument> {
  let submitted = doc.date_submitted;
  const resend = Boolean(submitted);
  if (submitted) {
    const found = await findSubmitted(ctx, kind, input.Contact.ContactID, input.Reference);
    if (found) {
      return found;
    }
    if (now(ctx).getTime() - new Date(submitted).getTime() < SETTLE_MS) {
      throw new XeroError("unavailable", 0, "Xero has not confirmed the last attempt yet. The app tries again in a minute.");
    }
  } else {
    submitted = now(ctx).toISOString();
  }
  await save(ctx.swell, doc, { ...details, date_submitted: submitted });
  try {
    // The same request after a lost answer carries the same key, and Xero answers it from
    // memory instead of creating the document again
    const created = await createDocument(api(ctx), kind, input, `${doc.id}:${await hash(`${submitted}|${JSON.stringify(input)}`)}`);
    if (!resend) {
      return created;
    }
    // A remembered answer describes the document as it was then. One deleted since (the
    // search above left it out) is not taken: the document is created anew
    const current = await getDocument(api(ctx), kind, created.id).catch((err: unknown) => {
      if (err instanceof XeroError && err.notFound) {
        return undefined;
      }
      throw err;
    });
    if (current && current.status !== "DELETED" && current.status !== "VOIDED") {
      return current;
    }
    const fresh = now(ctx).toISOString();
    await save(ctx.swell, doc, { date_submitted: fresh });
    return await createDocument(api(ctx), kind, input, `${doc.id}:${await hash(`${fresh}|${JSON.stringify(input)}`)}`);
  } catch (err) {
    if (err instanceof XeroError && !err.uncertain) {
      // Xero answered and did not create anything
      await save(ctx.swell, doc, { date_submitted: null });
    }
    throw err;
  }
}

/** Removes a draft of the app that is not wanted after all */
async function discard(ctx: Context, doc: DocumentRecord, kind: Kind, id: string): Promise<void> {
  await deleteDraft(api(ctx), kind, id);
  await save(ctx.swell, doc, { date_submitted: null });
}

/**
 * The Xero contact for the order's customer: the one an earlier order of the customer used,
 * the one that carries the customer's Swell id or e-mail address, or a new one. Existing
 * contacts are never changed.
 */
async function ensureContact(ctx: Context, doc: DocumentRecord, built: BuiltInvoice): Promise<string> {
  if (doc.contact_id && doc.contact_key === built.contactKey) {
    return doc.contact_id;
  }
  const earlier = (await ctx.swell.get("/documents", {
    where: { contact_key: built.contactKey, contact_id: { $ne: null } },
    sort: "date_created desc",
    limit: 1,
  })) as { results?: DocumentRecord[] };
  const known = earlier?.results?.[0]?.contact_id;
  let id = known && (await getContact(api(ctx), known))?.id;

  if (!id) {
    const number = built.contact.ContactNumber;
    const email = built.contact.EmailAddress;
    const found = await findContacts(api(ctx), { number, email });
    id = (
      (number && found.find((contact) => contact.number === number)) ||
      (email && found.find((contact) => (contact.email || "").toLowerCase() === email)) ||
      undefined
    )?.id;
  }

  if (!id) {
    const key = `contact:${await hash(`${built.contactKey}|${JSON.stringify(built.contact)}`)}`;
    try {
      id = (await createContact(api(ctx), built.contact, key)).id;
    } catch (err) {
      // Contact names are unique in Xero. Another customer has this one
      if (!(err instanceof XeroError && err.kind === "rejected" && /already assigned|must be unique/i.test(err.message))) {
        throw err;
      }
      const tag = built.contact.EmailAddress || doc.order_number || built.contactKey;
      const contact = { ...built.contact, Name: `${built.contact.Name} (${tag})`.slice(0, 255) };
      id = (await createContact(api(ctx), contact, `contact:${await hash(`${built.contactKey}|${JSON.stringify(contact)}`)}`)).id;
    }
  }
  await save(ctx.swell, doc, { contact_id: id, contact_key: built.contactKey });
  return id;
}

/** What the documents list shows about an order, known before any invoice can be built */
function orderDetails(order: SwellRecord): Partial<DocumentRecord> {
  return {
    name: provisionalName("invoice", String(order.number || "")),
    order_number: String(order.number || ""),
    account_id: order.account_id,
    amount: order.grand_total,
    currency: order.currency,
    customer_name: order.billing?.name || order.shipping?.name || order.account?.name,
    customer_email: order.account?.email,
  };
}

function readOrder(ctx: Context, orderId: string): Promise<SwellRecord> {
  return ctx.swell.get(`/orders/${orderId}`, { expand: ["account"] }) as Promise<SwellRecord>;
}

async function readPayments(ctx: Context, orderId: string): Promise<SwellRecord[]> {
  const found = (await ctx.swell.get("/payments", { where: { order_id: orderId }, limit: 100 })) as { results?: SwellRecord[] };
  return found?.results || [];
}

function invoiceInput(built: BuiltInvoice, layout: Layout, contactId: string, date: string, due: string): InvoiceInput {
  return {
    Type: "ACCREC",
    Contact: { ContactID: contactId },
    Date: date,
    DueDate: due,
    LineAmountTypes: layout.lineAmountTypes,
    Reference: built.reference,
    CurrencyCode: built.currency,
    Status: "DRAFT",
    LineItems: layout.lines.map((line) => toLineItem(line, true)),
  };
}

async function createInvoice(ctx: Context, doc: DocumentRecord): Promise<XeroDocument> {
  const orderId = doc.order_id as string;
  const order = ctx.orders?.[orderId] || (await readOrder(ctx, orderId));
  if (!order?.id) {
    throw new Problem("failed", "no_order", "The order no longer exists.");
  }

  let built: BuiltInvoice;
  try {
    checkOrder(order);
    built = buildInvoice(order, await buildOptions(ctx));
  } catch (err) {
    // What is known about the order is kept even when no invoice can be built for it
    if (!doc.order_number) {
      await save(ctx.swell, doc, orderDetails(order));
    }
    throw err;
  }

  const contactId = await ensureContact(ctx, doc, built);
  const org = await organisation(ctx);
  const date = xeroDay(order.date_created, zoneOf(org.timezone));
  // A paid order is due on its date. An unpaid one gets the organisation's sales terms
  const due = order.paid ? date : dueDate(date, org.salesTerms);
  const details: Partial<DocumentRecord> = {
    ...orderDetails(order),
    customer_name: built.customerName,
    customer_email: built.customerEmail,
    amount: built.totalCents / 100,
    currency: built.currency,
    tax_note: built.taxNote,
  };

  try {
    // Xero's own total on the draft decides. A tax-exclusive draft that is a cent off is
    // replaced by the same lines with amounts including tax; if that differs too, nothing
    // is approved
    let saved = await submit(ctx, doc, "Invoice", invoiceInput(built, built.layout, contactId, date, due), details);
    if (toCents(saved.total) !== built.totalCents && built.fallback) {
      await discard(ctx, doc, "Invoice", saved.id);
      saved = await submit(ctx, doc, "Invoice", invoiceInput(built, built.fallback, contactId, date, due), details);
    }
    if (toCents(saved.total) !== built.totalCents) {
      await discard(ctx, doc, "Invoice", saved.id);
      throw new Problem(
        "failed",
        "total_mismatch",
        `Xero calculates ${formatCents(toCents(saved.total))} ${built.currency} for this order, and its total is ${formatCents(built.totalCents)} ${built.currency}. No invoice was kept. Create it in Xero by hand.`,
      );
    }
    return saved;
  } catch (err) {
    if (err instanceof XeroError && err.kind === "rejected") {
      err.hint = explainRejection(err.message, built.currency);
    }
    throw err;
  }
}

async function createCreditNote(ctx: Context, doc: DocumentRecord): Promise<XeroDocument> {
  const orderId = doc.order_id as string;
  const invoiceDoc = await findByKey(ctx.swell, invoiceKey(orderId));
  if (invoiceDoc?.status === "resolved") {
    throw new Problem(
      "failed",
      "invoice_by_hand",
      "The invoice for this order was resolved by hand, so the app does not know it in Xero. Create this credit note in Xero by hand, then mark it as resolved.",
    );
  }
  if (!invoiceDoc?.xero_id) {
    throw new Problem("failed", "no_invoice", "The invoice for this order has not been created in Xero yet. Create it first, then retry this credit note.");
  }

  const [invoice, earlier, taxRates, org] = await Promise.all([
    getDocument(api(ctx), "Invoice", invoiceDoc.xero_id).catch((err: unknown) => {
      if (err instanceof XeroError && err.notFound) {
        return undefined;
      }
      throw err;
    }),
    ctx.swell.get("/documents", {
      where: { order_id: orderId, type: "credit_note", xero_id: { $ne: null }, id: { $ne: doc.id } },
      limit: 100,
    }) as Promise<{ results?: DocumentRecord[] }>,
    getTaxRates(api(ctx)).catch((): TaxRate[] => []),
    organisation(ctx),
  ]);
  if (!invoice || invoice.status === "DELETED" || invoice.status === "VOIDED") {
    throw new Problem(
      "failed",
      "invoice_gone",
      `${describe(invoiceDoc)} no longer exists in the connected Xero organisation, or was voided, so the credit note cannot be built from it. Create this credit note in Xero by hand, then mark it as resolved.`,
    );
  }
  if (isDraft(invoice.status)) {
    throw new Problem(
      "failed",
      "invoice_draft",
      `${describe(invoiceDoc)} is still a draft in Xero. Approve the invoice, then retry this credit note.`,
    );
  }

  const orderNumber = doc.order_number || invoiceDoc.order_number || "";
  const built = buildCreditNote({
    invoice,
    refundCents: toCents(doc.amount),
    earlierCents: (earlier?.results || []).reduce((sum, credit) => sum + toCents(credit.amount), 0),
    orderNumber,
    taxNames: Object.fromEntries(taxRates.map((rate) => [rate.taxType, rate.name])),
  });
  const reference = `Order ${orderNumber}, refund ${doc.reference || String(doc.refund_id || doc.id).slice(-8).toUpperCase()}`.slice(0, 255);
  const input: CreditNoteInput = {
    Type: "ACCRECCREDIT",
    Contact: { ContactID: invoice.contactId },
    Date: xeroDay(doc.date_created, zoneOf(org.timezone)),
    LineAmountTypes: built.lineAmountTypes,
    Reference: reference,
    CurrencyCode: invoice.currency,
    Status: "DRAFT",
    LineItems: built.lines,
  };
  const saved = await submit(ctx, doc, "CreditNote", input, {
    invoice_number: invoice.number,
    contact_id: invoice.contactId,
    currency: invoice.currency,
  });
  if (toCents(saved.total) !== built.totalCents) {
    await discard(ctx, doc, "CreditNote", saved.id);
    throw new Problem(
      "failed",
      "total_mismatch",
      `Xero calculates ${formatCents(toCents(saved.total))} ${invoice.currency} for this credit note, and the refund is ${formatCents(built.totalCents)} ${invoice.currency}. No credit note was kept. Create it in Xero by hand.`,
    );
  }
  return saved;
}

/** What the app did about the invoice's payments: each one recorded on the account its method has */
async function bookInvoice(ctx: Context, doc: DocumentRecord, known: XeroDocument): Promise<Partial<DocumentRecord>> {
  const orderId = doc.order_id as string;
  const [payments, org, remote] = await Promise.all([
    readPayments(ctx, orderId),
    organisation(ctx),
    // The payments already on the invoice are needed. An answer that does not list them is read again
    known.payments ? known : getDocument(api(ctx), "Invoice", known.id),
  ]);
  const total = toCents(remote.total);
  const plan = planBookings(payments, ctx.settings, total);
  let paid = toCents(remote.amountPaid);
  // Credit notes allocated to the invoice lower what is open, and Xero takes no more than that
  let due = toCents(remote.amountDue);

  if (plan.bookings.length > 0 && due > 0) {
    const accounts = await getAccounts(api(ctx));
    const resolved = plan.bookings.map((booking) => resolvePaymentAccount(accounts, booking.account));
    // What the app recorded already is counted against the first payments, so a payment whose
    // answer was lost is not recorded again. Payments the merchant recorded in Xero are not
    // the app's, and are left out of the count
    let covered = (remote.payments || [])
      .filter((payment) => payment.reference.startsWith(PAYMENT_REFERENCE))
      .reduce((sum, payment) => sum + toCents(payment.amount), 0);
    for (const [index, booking] of plan.bookings.entries()) {
      if (covered >= booking.cents) {
        covered -= booking.cents;
        continue;
      }
      const cents = Math.min(booking.cents - covered, due);
      covered = 0;
      if (cents <= 0) {
        continue;
      }
      const account = resolved[index];
      await createPayment(
        api(ctx),
        {
          invoiceId: remote.id,
          accountId: account.id,
          amount: cents / 100,
          date: xeroDay(booking.date, zoneOf(org.timezone)),
          reference: `${PAYMENT_REFERENCE}${doc.order_number || ""}, ${booking.method || "payment"}`,
        },
        `${doc.id}:pay:${await hash(`${remote.id}|${booking.paymentId}|${account.id}|${cents}`)}`,
      );
      paid += cents;
      due -= cents;
    }
  }
  return {
    booked_amount: paid / 100,
    date_booked: now(ctx).toISOString(),
    booking_note: describeBooking(plan, paid, total, remote.currency, Boolean((ctx.settings.payments?.account || "").trim())),
    xero_status: due <= 0 ? "paid" : statusName(remote.status),
  };
}

/** The refund of a credit note, paid out from the account of the refund's payment method */
async function bookCreditNote(ctx: Context, doc: DocumentRecord, remote: XeroDocument): Promise<Partial<DocumentRecord>> {
  const name = accountFor(ctx.settings, doc.payment_method);
  const invoiceDoc = doc.order_id ? await findByKey(ctx.swell, invoiceKey(doc.order_id)) : undefined;
  // The customer's money was recorded in Xero by the app; otherwise the refund is left for
  // the merchant to reconcile against the open credit note
  const recorded = toCents(invoiceDoc?.booked_amount) > 0;
  let status = remote.status;
  let paidOut = remote.amountDue <= 0;

  if (name && recorded && !paidOut) {
    const [accounts, org] = await Promise.all([getAccounts(api(ctx)), organisation(ctx)]);
    const account = resolvePaymentAccount(accounts, name);
    const cents = toCents(remote.amountDue);
    await createPayment(
      api(ctx),
      {
        creditNoteId: remote.id,
        accountId: account.id,
        amount: cents / 100,
        date: xeroDay(doc.date_created, zoneOf(org.timezone)),
        reference: `${PAYMENT_REFERENCE}${doc.order_number || ""}, refund`,
      },
      `${doc.id}:refund:${await hash(`${remote.id}|${account.id}|${cents}`)}`,
    );
    paidOut = true;
    status = "PAID";
  }
  let note = "Refund paid out in Xero.";
  if (!paidOut) {
    note = !name
      ? `Not paid out: ${doc.payment_method ? `refunds by ${doc.payment_method} have` : "the refund has"} no Xero account in the app's settings. The credit note stays open in Xero.`
      : "Not paid out: the order's payments were not recorded in Xero by the app. The credit note stays open in Xero, to reconcile with the refund.";
  }
  return {
    booked_amount: paidOut ? remote.total : 0,
    date_booked: now(ctx).toISOString(),
    booking_note: note,
    xero_status: statusName(status),
  };
}

/** Clears what the record knows about a Xero document that is gone, and says so */
async function gone(ctx: Context, doc: DocumentRecord, deleted: boolean): Promise<never> {
  const what = describe(doc);
  await save(ctx.swell, doc, {
    xero_id: null,
    xero_url: null,
    xero_status: null,
    number: null,
    date_issued: null,
    date_booked: null,
    booked_amount: null,
    date_submitted: null,
    name: provisionalName(doc.type, doc.order_number),
  });
  throw new Problem(
    "failed",
    "gone",
    `${what} was ${deleted ? "deleted or voided in Xero" : "not found in the connected Xero organisation"}. Retry to create the document again, or mark it as resolved.`,
  );
}

/**
 * Everything after the draft exists: approving it and recording the payments. Returns the
 * changes for the caller to save in one write with the final status. `known` is the
 * document as Xero just answered it.
 */
async function finish(ctx: Context, doc: DocumentRecord, known?: XeroDocument): Promise<Partial<DocumentRecord>> {
  const kind = kindOf(doc);
  const id = doc.xero_id as string;
  let remote =
    known ||
    (await getDocument(api(ctx), kind, id).catch((err: unknown) => {
      if (err instanceof XeroError && err.notFound) {
        return gone(ctx, doc, false);
      }
      throw err;
    }));
  if (remote.status === "DELETED" || remote.status === "VOIDED") {
    return gone(ctx, doc, true);
  }

  if (isDraft(remote.status)) {
    if (!wantsApproved(ctx)) {
      return { amount: remote.total, number: remote.number, ...(remote.number ? { name: remote.number } : {}), xero_status: statusName(remote.status) };
    }
    remote = await approve(api(ctx), kind, id, `${doc.id}:approve:${id}`);
  }
  const changes: Partial<DocumentRecord> = {
    amount: remote.total,
    number: remote.number,
    ...(remote.number ? { name: remote.number } : {}),
    xero_status: statusName(remote.status),
    // Xero's day at noon UTC, which is the same day in every time zone the dashboard shows it in
    ...(doc.date_issued && !isDraft(doc.xero_status) ? {} : { date_issued: remote.date ? `${remote.date}T12:00:00.000Z` : now(ctx).toISOString() }),
  };

  const booked = Boolean(doc.date_booked) && !(ctx.rebook && doc.type === "invoice");
  if (booked) {
    return changes;
  }
  try {
    return { ...changes, ...(doc.type === "invoice" ? await bookInvoice(ctx, doc, remote) : await bookCreditNote(ctx, doc, remote)) };
  } catch (err) {
    // Keep what was done before the failure is reported
    await save(ctx.swell, doc, changes);
    throw err;
  }
}

/** Xero's validation messages, with what the merchant can do about the common ones */
export function explainRejection(message: string, currency: string): string | undefined {
  if (/not subscribed to currency|currency.*(not|isn't).*(enabled|available)/i.test(message)) {
    return `Xero does not take invoices in ${currency} for this organisation. Add ${currency} under Accounting > Advanced > Currencies in Xero (multi-currency needs a Xero plan that includes it), then retry. (Xero: ${message})`;
  }
  if (/limit of invoices you can approve/i.test(message)) {
    return `The Xero plan's monthly limit of approved invoices is reached. The invoice is a draft in Xero: approve it there once the plan allows it, then choose Retry on this document. (Xero: ${message})`;
  }
  if (/Account code .* (is not valid|has been archived)/i.test(message)) {
    return `Xero does not accept an account the app's settings name. Check the accounts under Invoices, Tax rates and Payments (Test connection lists them), then retry. (Xero: ${message})`;
  }
  if (/TaxType code .* cannot be used with account code/i.test(message)) {
    return `Xero does not allow the order's tax rate on the account for it. Choose another account under Invoices, or another tax rate under Tax rates, then retry. (Xero: ${message})`;
  }
  return undefined;
}

function successMessage(doc: DocumentRecord): string {
  if (isDraft(doc.xero_status)) {
    return `${describe(doc)} is a draft in Xero. Approve it there and choose Read again from Xero, or choose Approve draft on the document in Swell.`;
  }
  return [`${describe(doc)} is in Xero.`, doc.booking_note].filter(Boolean).join(" ");
}

function alertSubject(doc: DocumentRecord): string {
  return `${doc.type === "invoice" ? "Invoice" : "Credit note"} for order ${doc.order_number || doc.order_id || ""}`.trim();
}

/**
 * Works on one record until it is complete or something stops it. Never throws for a Xero
 * or data problem. `fresh` says the caller created the record a moment ago, with the lock
 * already on it.
 */
export async function run(ctx: Context, doc: DocumentRecord, fresh = false): Promise<Outcome> {
  if (doc.status === "resolved") {
    return { doc, result: "exists", message: `${describe(doc)} was marked as resolved.` };
  }
  if (isComplete(ctx, doc)) {
    return { doc, result: "exists", message: `${describe(doc)} is in Xero already.` };
  }
  if (!fresh) {
    const started = now(ctx);
    const held = doc.locked_until && new Date(doc.locked_until).getTime() > started.getTime();
    if (held || !(await take(ctx.swell, doc, lock(started)))) {
      return { doc, result: "busy", message: `${describe(doc)} is being worked on right now. Try again in a moment.` };
    }
  }

  // The attempt is over, one way or the other, and the record is waiting for nothing
  const settled = { locked_until: null, date_pending: null };
  try {
    let draft: XeroDocument | undefined;
    if (!doc.xero_id) {
      draft = await (doc.type === "invoice" ? createInvoice(ctx, doc) : createCreditNote(ctx, doc));
      const org = await organisation(ctx);
      await save(ctx.swell, doc, {
        xero_id: draft.id,
        xero_url: documentLink(kindOf(doc), draft.id, org.shortCode),
        xero_status: statusName(draft.status),
        number: draft.number,
        ...(draft.number ? { name: draft.number } : {}),
        date_submitted: null,
      });
    }
    const changes = await finish(ctx, doc, draft);
    await save(ctx.swell, doc, { ...changes, status: "created", problem: null, problem_code: null, ...settled });
    // Only now, with the record no longer failed: settled any earlier, a failure of the
    // steps above would raise an alert while the old one is being removed
    await settleAlerts(ctx.swell);
    return { doc, result: "created", message: successMessage(doc) };
  } catch (err) {
    if (err instanceof Problem) {
      await save(ctx.swell, doc, { status: err.status, problem: err.message, problem_code: err.code, ...settled });
      if (err.status === "failed") {
        await raiseAlert(ctx.swell, "documents", err.message, alertSubject(doc));
      }
      return { doc, result: err.status, message: err.message };
    }

    if (err instanceof XeroError) {
      if (err.temporary) {
        // The record keeps what it has. With a Xero id it only needs finishing
        await save(ctx.swell, doc, {
          status: doc.status === "created" ? "created" : "pending",
          problem: err.message,
          problem_code: "temporary",
          locked_until: null,
          date_pending: doc.date_pending || now(ctx).toISOString(),
        });
        return { doc, result: "retry", message: err.message };
      }
      // Also for a document that exists in Xero and could not be finished: it needs the
      // merchant, and Retry finishes it without creating anything
      const message = err.connection
        ? err.message
        : err.hint || explainRejection(err.message, doc.currency || "") || `Xero refused the ${doc.xero_id ? "request" : "document"}: ${err.message}`;
      await save(ctx.swell, doc, {
        status: "failed",
        problem: message,
        problem_code: err.connection ? "connection" : "rejected",
        ...settled,
      });
      await raiseAlert(ctx.swell, err.connection ? "connection" : "documents", message, alertSubject(doc));
      return { doc, result: "failed", message };
    }

    // A fault of the store API or of the app itself. Release the record and let the caller see it
    try {
      await save(ctx.swell, doc, { locked_until: null, problem: String((err as Error)?.message || err), problem_code: "internal" });
    } catch {
      // The lock ends by itself
    }
    throw err;
  }
}

// How long a document that Xero cannot take right now is tried again before it is handed
// to the merchant
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** True for a record that has been waiting for Xero for a day */
export function waitedTooLong(ctx: Context, doc: DocumentRecord): boolean {
  return Boolean(doc.date_pending) && now(ctx).getTime() - new Date(doc.date_pending as string).getTime() > GIVE_UP_MS;
}

/** Marks a record that could not be completed in time as needing attention */
export async function giveUp(ctx: Context, doc: DocumentRecord): Promise<void> {
  const message = `The document could not be finished within a day. ${doc.problem || ""}`.trim();
  await save(ctx.swell, doc, {
    status: "failed",
    problem: message,
    problem_code: "unavailable",
    locked_until: null,
    date_pending: null,
  });
  await raiseAlert(ctx.swell, "documents", message, alertSubject(doc));
}

/**
 * The record for an order's invoice: found, or written now. `locked` says the caller goes
 * on to work on it in the same breath; a function that only starts a run leaves it free.
 */
export async function claimInvoice(
  ctx: Context,
  orderId: string,
  source: string,
  locked: boolean,
): Promise<{ doc: DocumentRecord; created: boolean }> {
  const key = invoiceKey(orderId);
  const [existing, order] = await Promise.all([findByKey(ctx.swell, key), readOrder(ctx, orderId).catch(() => undefined)]);
  if (order?.id) {
    ctx.orders = { ...ctx.orders, [orderId]: order };
  }
  if (existing) {
    return { doc: existing, created: false };
  }
  return claim(
    ctx.swell,
    key,
    { type: "invoice", order_id: orderId, source, ...(order?.id ? orderDetails(order) : {}), ...attempt(now(ctx), locked) },
    true,
  );
}

/**
 * The record for a refund's credit note. Returns nothing when the refund is none of the
 * app's business: it belongs to no order, or to an order the app never invoiced.
 */
export async function claimCreditNote(
  ctx: Context,
  refund: SwellRecord,
  source: string,
): Promise<{ doc: DocumentRecord; created: boolean } | undefined> {
  if (!creditNotesEnabled(ctx.settings) || !refund?.id || !refund.order_id) {
    return undefined;
  }
  const key = creditNoteKey(refund.id);
  const [invoiceDoc, existing] = await Promise.all([findByKey(ctx.swell, invoiceKey(refund.order_id)), findByKey(ctx.swell, key)]);
  if (!invoiceDoc || invoiceDoc.status === "skipped") {
    return undefined;
  }
  if (existing) {
    return { doc: existing, created: false };
  }
  return claim(
    ctx.swell,
    key,
    {
      type: "credit_note",
      name: provisionalName("credit_note", invoiceDoc.order_number),
      source,
      order_id: refund.order_id,
      order_number: invoiceDoc.order_number,
      account_id: invoiceDoc.account_id,
      payment_id: refund.parent_id,
      refund_id: refund.id,
      payment_method: refund.method,
      reference: String(refund.number || refund.id).slice(-8).toUpperCase(),
      customer_name: invoiceDoc.customer_name,
      customer_email: invoiceDoc.customer_email,
      amount: refund.amount,
      currency: invoiceDoc.currency,
      ...attempt(now(ctx), false),
    },
    true,
  );
}

/**
 * Marks an invoice whose payments were dealt with before they covered it as waiting for
 * its payments again: the order was paid since, or the merchant asks for another look. The
 * record says so itself, so an attempt that fails leaves the payments to the next one, and
 * the sweep finds the record when no run comes for it at all.
 */
export async function awaitBooking(ctx: Context, doc: DocumentRecord): Promise<void> {
  if (doc.type !== "invoice" || !doc.xero_id || !doc.date_booked || toCents(doc.booked_amount) >= toCents(doc.amount)) {
    return;
  }
  if (doc.status !== "created" && doc.status !== "failed") {
    return;
  }
  await save(ctx.swell, doc, {
    date_booked: null,
    ...(doc.status === "created" ? { status: "pending", ...attempt(now(ctx), false) } : {}),
  });
}

/** The invoice for an order: created now, or continued from where its record stands */
export async function invoiceOrder(ctx: Context, orderId: string, source: string): Promise<Outcome> {
  const { doc, created } = await claimInvoice(ctx, orderId, source, true);
  if (!created && ctx.rebook) {
    await awaitBooking(ctx, doc);
  }
  return run(ctx, doc, created);
}
