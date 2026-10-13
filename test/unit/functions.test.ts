import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import creditRefund from "../../functions/credit-refund";
import invoiceOrder from "../../functions/invoice-order";
import ProcessDocuments from "../../functions/process-documents";
import resolveDocument from "../../functions/resolve-document";
import sweep from "../../functions/sweep";
import testConnection, { describeAccounts, describeScopes } from "../../functions/test-connection";
import type { Account, Organisation } from "../../functions/lib/xero";
import * as orders from "../fixtures/orders";
import { createMockRequest } from "../helpers/mock-request";
import { createStore } from "../helpers/store";
import { CLIENT_ID, CLIENT_SECRET, createXero } from "../helpers/xero";

const SETTINGS = {
  id: "app-record-id",
  connection: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, enabled: true },
  invoices: { status: "authorised", sales_account: "200" },
  payments: { account: "Stripe Clearing" },
};
const order = orders.simple;
const ORDER_ID = order.id;

let store: ReturnType<typeof createStore>;
let xero: ReturnType<typeof createXero>;

function request(data: Record<string, any>) {
  return createMockRequest({ data, swell: store.swell as any, appId: "xero" });
}

async function thrown(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("Expected the function to throw");
}

/** A step runner that runs each step once, like a run without failures */
const step = {
  do: vi.fn(async (_name: string, _options: unknown, work: () => Promise<unknown>) => work()),
} as any;

function workflow(data: Record<string, any>, trigger = "action") {
  return new ProcessDocuments().run({ data, swell: store.swell, workflow: { trigger }, appId: "xero" } as any, step) as Promise<any>;
}

/** Runs what the event functions started, the way the platform would */
async function runStarted() {
  const results = [];
  for (const started of store.runs.splice(0)) {
    results.push(await workflow(started.data, "function"));
  }
  return results;
}

function action(extra: Record<string, any>) {
  return { $action: { id: "x", source: "record", user_id: "user-1", ...extra } };
}

const selection = (ids: string[]) => ({ query: { $and: [{ id: { $in: ids } }] } });

beforeEach(() => {
  store = createStore({
    settings: SETTINGS,
    orders: Object.values(orders),
    payments: [{ id: "pay-1", order_id: ORDER_ID, method: "card", amount: order.grand_total, success: true, date_created: "2026-10-12T22:31:00.000Z" }],
  });
  xero = createXero();
  step.do.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("order.paid", () => {
  it("writes the document's record and starts a run for it, without calling Xero", async () => {
    const result = await invoiceOrder(request({ ...order, $event: { type: "order.paid" } }));
    expect(store.documents).toMatchObject([{ key: `invoice:${ORDER_ID}`, status: "pending", source: "order.paid", order_number: "1001" }]);
    expect(store.runs).toEqual([{ name: "process-documents", data: { document_id: store.documents[0].id, rebook: true } }]);
    expect(result).toMatchObject({ document: store.documents[0].id });
    expect(fetch).not.toHaveBeenCalled();

    expect(await runStarted()).toMatchObject([{ result: "created", number: "INV-0001" }]);
    expect(store.documents[0]).toMatchObject({ status: "created", xero_status: "paid" });
  });

  it("starts nothing for an order whose invoice is complete, or while the app is switched off", async () => {
    await invoiceOrder(request({ ...order }));
    await runStarted();
    expect(await invoiceOrder(request({ ...order }))).toMatchObject({ skipped: expect.any(String) });
    expect(store.runs).toHaveLength(0);

    store.setSettings({ ...SETTINGS, connection: { ...SETTINGS.connection, enabled: false } });
    await invoiceOrder(request({ ...orders.discounted }));
    expect(store.documents).toHaveLength(1);
  });

  it("records the payment of an order that was invoiced before it was paid", async () => {
    const [payment] = store.payments.splice(0);
    await workflow(action({ id: "create-invoice", record_id: ORDER_ID }));
    expect(store.documents[0]).toMatchObject({ status: "created", xero_status: "authorised", booked_amount: 0 });

    store.payments.push(payment);
    store.documents[0].locked_until = null;
    await invoiceOrder(request({ ...order }));
    expect(store.documents[0]).toMatchObject({ status: "pending", date_booked: null });
    await runStarted();
    expect(store.documents[0]).toMatchObject({ status: "created", xero_status: "paid", booked_amount: 51.75 });
    expect(xero.invoices).toHaveLength(1);
  });

  it("fails the delivery when the run cannot be started, and keeps the record", async () => {
    store.swell.workflows.create.mockRejectedValueOnce(Object.assign(new Error("Too many requests"), { status: 429 }));
    expect((await thrown(() => invoiceOrder(request({ ...order })))).status).toBe(429);
    expect(store.documents).toHaveLength(1);

    await invoiceOrder(request({ ...order }));
    expect(store.documents).toHaveLength(1);
    expect(store.runs).toHaveLength(1);
  });
});

describe("payment.refund.succeeded", () => {
  it("starts a run for the credit note of an invoiced order only", async () => {
    const refund = { id: "refund-1", order_id: ORDER_ID, parent_id: "pay-1", amount: 10, method: "card", number: "100023" };
    expect(await creditRefund(request(refund))).toMatchObject({ skipped: expect.any(String) });

    await invoiceOrder(request({ ...order }));
    await runStarted();
    await creditRefund(request(refund));
    expect(await runStarted()).toMatchObject([{ result: "created", number: "CN-0001" }]);
    expect(store.documents[1]).toMatchObject({ type: "credit_note", payment_method: "card", amount: 10, status: "created", xero_status: "paid" });
  });

  it("creates nothing when credit notes are switched off", async () => {
    store.setSettings({ ...SETTINGS, invoices: { ...SETTINGS.invoices, credit_notes: false } });
    await invoiceOrder(request({ ...order }));
    await runStarted();
    expect(await creditRefund(request({ id: "refund-1", order_id: ORDER_ID, amount: 10, method: "card" }))).toMatchObject({ skipped: expect.any(String) });
  });
});

describe("the workflow", () => {
  it("fails the step while Xero is unreachable, so the run waits and repeats it", async () => {
    await invoiceOrder(request({ ...order }));
    xero.state.intercept = () => xero.json(503, { Message: "The Organisation is offline" });
    const [started] = store.runs.splice(0);
    await expect(workflow(started.data, "function")).rejects.toThrowError(/offline for maintenance/);
    expect(store.documents[0]).toMatchObject({ status: "pending", problem_code: "temporary" });
  });

  it("approves a draft from the document's page, and only then", async () => {
    store.setSettings({ ...SETTINGS, invoices: { ...SETTINGS.invoices, status: "draft" } });
    await workflow(action({ id: "create-invoice", record_id: ORDER_ID }));
    store.documents[0].locked_until = null;
    await workflow(action({ id: "refresh", record_id: store.documents[0].id }));
    expect(store.documents[0].xero_status).toBe("draft");

    store.documents[0].locked_until = null;
    await workflow(action({ id: "approve", record_id: store.documents[0].id }));
    expect(store.documents[0]).toMatchObject({ number: "INV-0001", xero_status: "paid" });
  });

  it("ignores a run that names nothing, and an id that is none", async () => {
    expect(await workflow({}, "function")).toMatchObject({ result: "ignored" });
    expect(await workflow(action({ id: "retry", record_id: "../orders" }))).toMatchObject({ result: "ignored" });
    expect(step.do).not.toHaveBeenCalled();
  });

  it("invoices the selected orders", async () => {
    const ids = [orders.simple.id, orders.discounted.id, orders.taxIncluded.id];
    const result = await workflow(action({ id: "invoice-selected", source: "bulk", selection: selection(ids) }));
    expect(result).toMatchObject({ created: 3, failed: 0 });
    expect(xero.invoices).toHaveLength(3);
  });

  it("approves the drafts of a selection and leaves the rest as it is", async () => {
    store.setSettings({ ...SETTINGS, invoices: { ...SETTINGS.invoices, status: "draft" } });
    await workflow(action({ id: "create-invoice", record_id: ORDER_ID }));
    store.documents[0].locked_until = null;
    store.documents.push({ id: "c".repeat(24), key: `invoice:${orders.discounted.id}`, type: "invoice", status: "failed", order_id: orders.discounted.id });

    const result = await workflow(action({ id: "approve-selected", source: "bulk", selection: selection(store.documents.map((doc) => doc.id)) }));
    expect(result).toMatchObject({ created: 1, failed: 0 });
    expect(store.documents[0]).toMatchObject({ xero_status: "paid" });
    expect(store.documents[1]).toMatchObject({ status: "failed" });
  });

  it("stops a bulk run when Xero refuses the connection, and retries after it is fixed", async () => {
    store.setSettings({ ...SETTINGS, connection: { ...SETTINGS.connection, client_secret: "wrong" } });
    await workflow(action({ id: "invoice-selected", source: "bulk", selection: selection([ORDER_ID, orders.discounted.id]) }));
    expect(store.documents.map((doc) => doc.status)).toEqual(["failed"]);

    store.setSettings(SETTINGS);
    store.documents[0].locked_until = null;
    const result = await workflow(action({ id: "retry-failed", source: "settings", settings: "connection" }));
    expect(result).toMatchObject({ created: 1, halted: false });
    expect(store.alerts).toHaveLength(0);
  });
});

describe("the sweep", () => {
  it("starts a run only when a document has waited without an attempt", async () => {
    expect(await sweep(request({}))).toEqual({ waiting: 0 });
    await invoiceOrder(request({ ...order }));
    store.runs.length = 0;
    expect(await sweep(request({}))).toEqual({ waiting: 0 });

    store.documents[0].date_attempted = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    expect(await sweep(request({}))).toMatchObject({ waiting: 1 });
    expect(store.runs).toEqual([{ name: "process-documents", data: { stale: true } }]);
    expect(await runStarted()).toMatchObject([{ created: 1 }]);
  });
});

describe("Test connection", () => {
  it("names the organisation, the accounts and payments, and what waits", async () => {
    store.documents.push({ id: "1", key: "k", status: "failed" });
    const result = await testConnection(request(action({ id: "test-connection", source: "field" })));
    expect(result.message).toMatch(
      /^Connected to Demo Company \(NZ\) \(NZ, NZD\)\. Invoices are created approved\. Sales go to 200 Sales\. Payments are recorded on 091 Stripe Clearing\. Orders with 0 % need a choice under Tax rates.*Zero Rated, No GST\..*1 document needs attention/,
    );
    expect(store.settings.connection.organisation).toBe("Demo Company (NZ)");
  });

  it("explains refused credentials and missing ones", async () => {
    store.setSettings({ ...SETTINGS, connection: { client_id: CLIENT_ID, client_secret: "wrong" } });
    const refused = await thrown(() => testConnection(request({})));
    expect(refused.status).toBe(400);
    expect(refused.message).toMatch(/did not accept the client ID and secret/);

    store.setSettings({ ...SETTINGS, connection: {} });
    expect((await thrown(() => testConnection(request({})))).message).toMatch(/Enter the client ID/);
  });

  it("names missing scopes", () => {
    expect(describeScopes(["accounting.contacts", "accounting.transactions", "accounting.settings"])).toBeUndefined();
    expect(describeScopes(["accounting.contacts", "accounting.invoices"])).toMatch(/lacks accounting\.payments \(for payments\), accounting\.settings\.read/);
    expect(describeScopes([])).toBeUndefined();
  });

  it("checks the accounts against Xero's", () => {
    const org = { countryCode: "US" } as Organisation;
    const accounts: Account[] = [
      { id: "1", code: "4000", name: "Sales", type: "REVENUE", class: "REVENUE", status: "ACTIVE", takesPayments: false },
      { id: "2", code: "1000", name: "Checking", type: "BANK", class: "ASSET", status: "ACTIVE", takesPayments: true },
      { id: "3", code: "2200", name: "Sales Tax Payable", type: "CURRLIAB", class: "LIABILITY", status: "ACTIVE", takesPayments: false },
    ];
    expect(describeAccounts({}, org, accounts)).toEqual([
      "Name the account for sales. Income accounts in Xero: 4000 Sales.",
      "Orders with sales tax need an account for it, under Tax rates. Liability accounts in Xero: 2200 Sales Tax Payable.",
      "Payments are not recorded: name an account under Payments. Accounts in Xero that take payments: 1000 Checking.",
    ]);
    const settings = { invoices: { sales_account: "sales" }, taxes: { sales_tax_account: "2200" }, payments: { account: "4000" } };
    expect(describeAccounts(settings, org, accounts)).toEqual([
      "Sales go to 4000 Sales.",
      "Sales tax goes on its own line, to 2200 Sales Tax Payable.",
      '"4000" does not take payments in Xero. Accounts in Xero that take payments: 1000 Checking.',
    ]);
  });
});

describe("Mark as resolved", () => {
  it("stops the app from creating the document, and keeps a number the merchant gives", async () => {
    store.documents.push({ id: "a".repeat(24), key: "k", type: "invoice", status: "failed", problem: "x" });
    store.alerts.push({ id: "1", key: "documents" });
    await resolveDocument(request({ number: " INV-77 ", ...action({ id: "resolve", record_id: "a".repeat(24) }) }));
    expect(store.documents[0]).toMatchObject({ status: "resolved", number: "INV-77" });
    expect(store.alerts).toHaveLength(0);

    expect(await workflow(action({ id: "retry", record_id: "a".repeat(24) }))).toMatchObject({ result: "exists" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a document that is in Xero as it is", async () => {
    store.documents.push({ id: "b".repeat(24), key: "k", type: "invoice", status: "failed", xero_id: "9", number: "INV-1" });
    await resolveDocument(request(action({ id: "resolve", record_id: "b".repeat(24) })));
    expect(store.documents[0]).toMatchObject({ status: "created", xero_id: "9" });
  });
});
