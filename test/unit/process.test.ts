import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "../../functions/lib/documents";
import { claimCreditNote, giveUp, invoiceOrder, run, waitedTooLong } from "../../functions/lib/process";
import type { Context } from "../../functions/lib/process";
import * as orders from "../fixtures/orders";
import { createStore } from "../helpers/store";
import { CLIENT_ID, CLIENT_SECRET, createXero } from "../helpers/xero";

const APPROVED = {
  id: "app-record-id",
  connection: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, enabled: true },
  invoices: { status: "authorised", sales_account: "200", shipping_account: "Other Revenue" },
  payments: { account: "091" },
};
const DRAFTS = { ...APPROVED, invoices: { ...APPROVED.invoices, status: "draft" } };

const order = orders.simple;
const paid = (source: Record<string, any>, method = "card", amount = source.grand_total, id = `pay-${source.id}-${method}`) => ({
  id, order_id: source.id, method, amount, success: true, captured: true, date_created: "2026-10-12T22:31:00.000Z",
});

let store: ReturnType<typeof createStore>;
let xero: ReturnType<typeof createXero>;
let clock: Date;

function context(settings: Record<string, any> = store.settings, extra: Partial<Context> = {}): Context {
  return { swell: store.swell, settings, now: () => clock, ...extra };
}

function setup(settings: Record<string, any> = APPROVED, payments: Record<string, any>[] = [paid(order)]) {
  store = createStore({ settings, orders: Object.values(orders), payments });
}

function later(seconds = 61) {
  clock = new Date(clock.getTime() + seconds * 1000);
}

async function refund(source: Record<string, any>, amount: number, id = "refund-1", method = "card") {
  const ctx = context();
  const claimed = await claimCreditNote(ctx, { id, order_id: source.id, parent_id: "pay-1", amount, method, number: "100023" }, "test");
  return claimed && run(ctx, claimed.doc);
}

beforeEach(() => {
  clock = new Date("2026-10-13T10:00:00.000Z");
  xero = createXero();
  setup();
});

afterEach(() => vi.unstubAllGlobals());

describe("an invoice, approved", () => {
  it("creates the contact, the draft, approves it and records the payment", async () => {
    const outcome = await invoiceOrder(context(), order.id, "order.paid");

    expect(outcome.result).toBe("created");
    expect(store.documents[0]).toMatchObject({
      key: `invoice:${order.id}`, status: "created", number: "INV-0001", name: "INV-0001", amount: 51.75, currency: "NZD",
      xero_status: "paid", booked_amount: 51.75, booking_note: "Paid in Xero.", tax_note: "15% GST on Income", problem: null, locked_until: null, date_pending: null,
    });
    expect(store.documents[0].xero_url).toBe(
      `https://go.xero.com/organisationlogin/default.aspx?shortcode=!nz1aB&redirecturl=${encodeURIComponent(`/AccountsReceivable/View.aspx?InvoiceID=${xero.invoices[0].InvoiceID}`)}`,
    );
    expect(xero.contacts).toMatchObject([{ Name: "Olivia Moore", EmailAddress: "olivia@example.com", ContactNumber: order.account_id }]);
    expect(xero.invoices[0]).toMatchObject({
      Status: "PAID", Reference: "1001", Date: expect.any(String), DateString: "2026-10-13T00:00:00", DueDate: "2026-10-13", LineAmountTypes: "Exclusive", Total: 51.75, CurrencyCode: "NZD",
    });
    expect(xero.invoices[0].LineItems.map((line: any) => line.AccountCode)).toEqual(["200", "260"]);
    expect(xero.payments).toMatchObject([{ Amount: 51.75, Date: "2026-10-13", Account: { AccountID: "acc-091" } }]);
    expect(xero.writes().map((call) => `${call.method} ${call.path.split("/")[1]}`)).toEqual(["PUT Contacts", "PUT Invoices", "POST Invoices", "PUT Payments"]);
    expect(xero.writes().every((call) => call.key && call.key.length <= 128)).toBe(true);
  });

  it("uses the customer's contact again for the next order", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    await invoiceOrder(context(), orders.discounted.id, "dashboard");
    expect(xero.contacts).toHaveLength(1);
    expect(xero.invoices).toHaveLength(2);
  });

  it("finds an existing contact by the customer's e-mail address", async () => {
    xero.contacts.push({ ContactID: "contact-existing", ContactStatus: "ACTIVE", Name: "O. Moore", EmailAddress: "Olivia@example.com" });
    await invoiceOrder(context(), order.id, "order.paid");
    expect(xero.contacts).toHaveLength(1);
    expect(xero.invoices[0].Contact.ContactID).toBe("contact-existing");
  });

  it("names a new contact apart when another contact has the name", async () => {
    xero.contacts.push({ ContactID: "contact-other", ContactStatus: "ACTIVE", Name: "Olivia Moore", EmailAddress: "someone@else.com" });
    await invoiceOrder(context(), order.id, "order.paid");
    expect(xero.contacts[1]).toMatchObject({ Name: "Olivia Moore (olivia@example.com)", ContactNumber: order.account_id });
  });

  it("replaces a draft that Xero totals a cent off with amounts including tax", async () => {
    // Xero rounds differently than expected: the first draft comes back a cent high
    xero.state.intercept = (call) => {
      if (call.method === "PUT" && call.path === "/Invoices" && call.body.Invoices[0].LineAmountTypes === "Exclusive") {
        call.body.Invoices[0].LineItems[0].UnitAmount += 0.005;
      }
      return undefined;
    };
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.result).toBe("created");
    expect(xero.invoices.map((invoice) => [invoice.LineAmountTypes, invoice.Status])).toEqual([["Exclusive", "DELETED"], ["Inclusive", "PAID"]]);
  });

  it("sends a cent-off order with tax included straight away", async () => {
    store = createStore({ settings: APPROVED, orders: Object.values(orders), payments: [paid(orders.oddCents)] });
    await invoiceOrder(context(), orders.oddCents.id, "order.paid");
    expect(xero.invoices.map((invoice) => [invoice.LineAmountTypes, invoice.Total, invoice.Status])).toEqual([["Inclusive", 107.49, "PAID"]]);
  });

  it("leaves a gift card payment open unless it has an account", async () => {
    setup(APPROVED, [paid(order, "card", 31.75), paid(order, "giftcard", 20)]);
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.doc).toMatchObject({ xero_status: "authorised", booked_amount: 31.75 });
    expect(outcome.doc.booking_note).toBe("31.75 of 51.75 NZD recorded as paid in Xero. Not recorded: 20.00 NZD paid by giftcard, which has no Xero account in the app's settings.");
  });

  it("records nothing without a payment account", async () => {
    setup({ ...APPROVED, payments: {} });
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.doc).toMatchObject({ xero_status: "authorised", booked_amount: 0, booking_note: "Not recorded: no Xero account for payments is set in the app's settings." });
    expect(xero.payments).toHaveLength(0);
  });

  it("gives an unpaid order the organisation's payment terms, and records the payment when it comes", async () => {
    setup(APPROVED, []);
    let outcome = await invoiceOrder(context(), orders.unpaid.id, "dashboard");
    expect(xero.invoices[0]).toMatchObject({ DueDate: "2026-11-20", Status: "AUTHORISED" });
    expect(outcome.doc.booking_note).toBe("Not recorded: the order has no payment yet.");

    store.payments.push(paid(orders.unpaid));
    outcome = await invoiceOrder(context(store.settings, { rebook: true }), orders.unpaid.id, "order.paid");
    expect(outcome.doc).toMatchObject({ xero_status: "paid", booked_amount: 51.75 });
    expect(xero.invoices).toHaveLength(1);
  });

  it("puts US sales tax on its own line", async () => {
    xero = createXero({ country: "US" });
    const settings = { ...APPROVED, invoices: { status: "authorised", sales_account: "4000" }, taxes: { sales_tax_account: "Sales Tax Payable" }, payments: { account: "1000" } };
    setup(settings, [paid(orders.unitedStates)]);
    const outcome = await invoiceOrder(context(), orders.unitedStates.id, "order.paid");
    expect(outcome.result).toBe("created");
    expect(xero.invoices[0]).toMatchObject({ LineAmountTypes: "NoTax", Total: 118.25, Status: "PAID" });
    expect(xero.invoices[0].LineItems.map((line: any) => [line.AccountCode, line.LineAmount])).toEqual([["4000", 100], ["4000", 10], ["2200", 8.25]]);
    expect(outcome.doc.tax_note).toBe("Sales tax on its own line");
  });
});

describe("an invoice, as a draft", () => {
  beforeEach(() => setup(DRAFTS));

  it("stops at the draft, and finishes once approved in Swell", async () => {
    let outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.doc).toMatchObject({ status: "created", xero_status: "draft", number: "INV-0001" });
    expect(outcome.message).toContain("is a draft in Xero");
    expect(xero.payments).toHaveLength(0);

    outcome = await run(context(store.settings, { approve: true }), store.documents[0] as DocumentRecord);
    expect(outcome.doc).toMatchObject({ xero_status: "paid", booked_amount: 51.75 });
  });

  it("records the payment after the draft was approved in Xero", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    xero.invoices[0].Status = "AUTHORISED";
    const outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome.doc).toMatchObject({ xero_status: "paid", booked_amount: 51.75 });
  });

  it("creates the invoice again after its draft was deleted in Xero", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    xero.invoices[0].Status = "DELETED";
    let outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome).toMatchObject({ result: "failed" });
    expect(outcome.doc.problem).toContain("was deleted or voided in Xero");
    expect(outcome.doc.xero_id).toBeNull();

    later(1);
    outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome.doc).toMatchObject({ status: "created", number: "INV-0002" });
  });
});

describe("credit notes", () => {
  it("credits a full refund with the invoice's lines and pays it out", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    const outcome = await refund(order, 51.75);
    expect(outcome?.result).toBe("created");
    expect(outcome?.doc).toMatchObject({ number: "CN-0001", invoice_number: "INV-0001", xero_status: "paid", booking_note: "Refund paid out in Xero." });
    expect(xero.creditNotes[0]).toMatchObject({ LineAmountTypes: "Exclusive", Total: 51.75, Reference: "Order 1001, refund 100023", Status: "PAID" });
    expect(xero.payments[1]).toMatchObject({ CreditNote: { CreditNoteID: xero.creditNotes[0].CreditNoteID }, Amount: 51.75, Account: { AccountID: "acc-091" } });
  });

  it("splits a partial refund over the invoice's accounts", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    await refund(order, 10);
    expect(xero.creditNotes[0]).toMatchObject({ LineAmountTypes: "Inclusive", Total: 10 });
    expect(xero.creditNotes[0].LineItems.map((line: any) => [line.AccountCode, line.LineAmount])).toEqual([["200", 8.89], ["260", 1.11]]);
  });

  it("leaves the credit note open when the refund's method has no account", async () => {
    setup({ ...APPROVED, payments: { account: "091", exceptions: [{ method: "paypal", account: "" }] } }, [paid(order, "paypal")]);
    await invoiceOrder(context(), order.id, "order.paid");
    const outcome = await refund(order, 51.75, "refund-1", "paypal");
    expect(outcome?.doc).toMatchObject({ xero_status: "authorised", booked_amount: 0 });
    expect(outcome?.doc.booking_note).toContain("refunds by paypal have no Xero account");
  });

  it("waits for the invoice to be approved", async () => {
    setup(DRAFTS);
    await invoiceOrder(context(), order.id, "order.paid");
    const outcome = await refund(order, 10);
    expect(outcome).toMatchObject({ result: "failed" });
    expect(outcome?.doc.problem).toContain("still a draft in Xero");
  });

  it("ignores refunds of orders the app never invoiced", async () => {
    expect(await refund(order, 10)).toBeUndefined();
  });
});

describe("review fixes", () => {
  it("reports a missing scope as such, without trying new tokens", async () => {
    let refused = 0;
    xero.state.intercept = (call) => {
      if (call.method === "PUT" && call.path === "/Payments") {
        refused += 1;
        return new Response(JSON.stringify({ Title: "Unauthorized", Status: 401 }), {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer error="insufficent_scope"' },
        });
      }
      return undefined;
    };
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.doc).toMatchObject({ status: "failed", problem_code: "connection" });
    expect(outcome.doc.problem).toContain("lacks a scope the app needs");
    expect(refused).toBe(1);
  });

  it("creates the invoice anew when a resent request is answered with a draft deleted since", async () => {
    let lose = true;
    xero.state.intercept = (call) => {
      if (lose && call.method === "PUT" && call.path === "/Invoices") {
        lose = false;
        return "lose-answer";
      }
      return undefined;
    };
    expect((await invoiceOrder(context(), order.id, "order.paid")).result).toBe("retry");
    // The draft the lost answer was about is deleted in Xero before the next attempt
    xero.invoices[0].Status = "DELETED";
    later();
    const outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome.result).toBe("created");
    expect(xero.invoices.map((invoice) => invoice.Status)).toEqual(["DELETED", "PAID"]);
    expect(outcome.doc.xero_id).toBe(xero.invoices[1].InvoiceID);
  });

  it("records no more than is open, and leaves payments the merchant recorded out of the count", async () => {
    setup(DRAFTS, [paid(order, "card", 31.75), paid(order, "bank", 20)]);
    store.setSettings({ ...DRAFTS, payments: { account: "091", exceptions: [{ method: "bank", account: "" }] } });
    await invoiceOrder(context(), order.id, "order.paid");
    // The merchant approves the draft in Xero and records the bank transfer there
    const invoice = xero.invoices[0];
    invoice.Status = "AUTHORISED";
    invoice.AmountPaid = 20;
    invoice.AmountDue = 31.75;
    invoice.Payments = [{ PaymentID: "manual", Amount: 20, Reference: "Bank transfer" }];
    const outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome.doc).toMatchObject({ xero_status: "paid", booked_amount: 51.75 });
    expect(xero.payments).toMatchObject([{ Amount: 31.75, Reference: "Swell order 1001, card" }]);
  });

  it("keeps the document's day the same in every time zone", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    expect(store.documents[0].date_issued).toBe("2026-10-13T12:00:00.000Z");
  });
});

describe("failures", () => {
  it("does not create the invoice twice when Xero's answer was lost", async () => {
    let lose = true;
    xero.state.intercept = (call) => {
      if (lose && call.method === "PUT" && call.path === "/Invoices") {
        lose = false;
        return "lose-answer";
      }
      return undefined;
    };
    let outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.result).toBe("retry");
    expect(store.documents[0]).toMatchObject({ status: "pending", problem_code: "temporary" });
    expect(store.documents[0].date_submitted).toBeTruthy();

    later(5);
    outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome.result).toBe("created");
    expect(xero.invoices).toHaveLength(1);
    expect(xero.payments).toHaveLength(1);
  });

  it("does not record a payment twice when its answer was lost", async () => {
    let lose = true;
    xero.state.intercept = (call) => {
      if (lose && call.method === "PUT" && call.path === "/Payments") {
        lose = false;
        return "lose-answer";
      }
      return undefined;
    };
    expect((await invoiceOrder(context(), order.id, "order.paid")).result).toBe("retry");
    later();
    expect((await run(context(), store.documents[0] as DocumentRecord)).result).toBe("created");
    expect(xero.payments).toHaveLength(1);
    expect(xero.invoices[0]).toMatchObject({ Status: "PAID", AmountPaid: 51.75 });
  });

  it("lists a refused connection under Needs attention and e-mails once", async () => {
    setup({ ...APPROVED, connection: { ...APPROVED.connection, client_secret: "wrong" } });
    const first = await invoiceOrder(context(), order.id, "order.paid");
    await invoiceOrder(context(), orders.discounted.id, "order.paid");
    expect(first.doc).toMatchObject({ status: "failed", problem_code: "connection" });
    expect(first.message).toContain("did not accept the client ID and secret");
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0]).toMatchObject({ key: "connection", count: 2 });
    expect(store.events).toEqual(["created /alerts"]);
  });

  it("explains a currency the organisation does not have", async () => {
    setup(APPROVED, [paid(orders.simple)]);
    store = createStore({ settings: APPROVED, orders: [{ ...orders.simple, currency: "AUD" }], payments: [] });
    const outcome = await invoiceOrder(context(), orders.simple.id, "order.paid");
    expect(outcome.doc.problem).toMatch(/^Xero does not take invoices in AUD/);
  });

  it("asks for the tax rate to use, and creates the invoice once it is set", async () => {
    setup(APPROVED, [paid(orders.untaxed)]);
    let outcome = await invoiceOrder(context(), orders.untaxed.id, "order.paid");
    expect(outcome.doc).toMatchObject({ status: "failed", problem_code: "tax_rate_ambiguous", order_number: "1005" });
    expect(store.alerts[0]).toMatchObject({ key: "documents", subject: "Invoice for order 1005" });

    store.setSettings({ ...APPROVED, taxes: { rates: [{ rate: 0, tax_rate: "Zero Rated" }] } });
    outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome.result).toBe("created");
    expect(xero.invoices[0].LineItems[0].TaxType).toBe("ZERORATED");
    expect(store.alerts).toHaveLength(0);
  });

  it("keeps the draft when the plan's limit of approved invoices is reached", async () => {
    xero.state.approvalLimit = 0;
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.doc).toMatchObject({ status: "failed", problem_code: "rejected" });
    expect(outcome.doc.problem).toContain("monthly limit of approved invoices");
    expect(outcome.doc.problem).toContain("choose Retry on this document");
    expect(outcome.doc.xero_id).toBeTruthy();
  });

  it("gives up on a document after a day of waiting", async () => {
    xero.state.intercept = () => new Response("", { status: 503 });
    const outcome = await invoiceOrder(context(), order.id, "order.paid");
    expect(outcome.result).toBe("retry");
    later(25 * 60 * 60);
    const ctx = context();
    expect(waitedTooLong(ctx, store.documents[0] as DocumentRecord)).toBe(true);
    await giveUp(ctx, store.documents[0] as DocumentRecord);
    expect(store.documents[0]).toMatchObject({ status: "failed", problem_code: "unavailable" });
  });

  it("lets only one of two simultaneous attempts work", async () => {
    await invoiceOrder(context(), order.id, "order.paid");
    store.documents[0].xero_status = "draft";
    store.documents[0].locked_until = new Date(clock.getTime() + 60000).toISOString();
    const outcome = await run(context(), store.documents[0] as DocumentRecord);
    expect(outcome.result).toBe("busy");
  });
});
