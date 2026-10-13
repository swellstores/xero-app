import { vi } from "vitest";
import { pacing, resetClient } from "../../functions/lib/xero";

type Row = Record<string, any>;

export const CLIENT_ID = "client-id";
export const CLIENT_SECRET = "client-secret";

export interface XeroCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  key: string | null;
}

/** Rounds to cents, half away from zero */
function round(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-7)) / 100;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function invalid(message: string): Response {
  return json(400, {
    ErrorNumber: 10,
    Type: "ValidationException",
    Message: "A validation exception occurred",
    Elements: [{ ValidationErrors: [{ Message: message }] }],
  });
}

function xeroDate(day: string): string {
  return `/Date(${new Date(`${day}T00:00:00.000Z`).getTime()}+0000)/`;
}

const ORGS: Record<string, Row> = {
  NZ: { Name: "Demo Company (NZ)", BaseCurrency: "NZD", CountryCode: "NZ", Timezone: "NEWZEALANDSTANDARDTIME", ShortCode: "!nz1aB" },
  US: { Name: "Demo Company (US)", BaseCurrency: "USD", CountryCode: "US", Timezone: "PACIFICSTANDARDTIME", ShortCode: "!us2cD" },
};

const ACCOUNTS: Record<string, Row[]> = {
  NZ: [
    { AccountID: "acc-200", Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
    { AccountID: "acc-260", Code: "260", Name: "Other Revenue", Type: "OTHERINCOME", Class: "REVENUE", Status: "ACTIVE" },
    { AccountID: "acc-090", Code: "090", Name: "Business Bank Account", Type: "BANK", Class: "ASSET", Status: "ACTIVE" },
    { AccountID: "acc-091", Code: "091", Name: "Stripe Clearing", Type: "BANK", Class: "ASSET", Status: "ACTIVE" },
    { AccountID: "acc-610", Code: "610", Name: "Accounts Receivable", Type: "CURRENT", Class: "ASSET", Status: "ACTIVE" },
    { AccountID: "acc-820", Code: "820", Name: "GST", Type: "CURRLIAB", Class: "LIABILITY", Status: "ACTIVE", SystemAccount: "GST" },
    { AccountID: "acc-201", Code: "201", Name: "Old Sales", Type: "REVENUE", Class: "REVENUE", Status: "ARCHIVED" },
  ],
  US: [
    { AccountID: "acc-4000", Code: "4000", Name: "Sales", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
    { AccountID: "acc-1000", Code: "1000", Name: "Checking", Type: "BANK", Class: "ASSET", Status: "ACTIVE" },
    { AccountID: "acc-2200", Code: "2200", Name: "Sales Tax Payable", Type: "CURRLIAB", Class: "LIABILITY", Status: "ACTIVE" },
  ],
};

const TAX_RATES: Record<string, Row[]> = {
  NZ: [
    { Name: "15% GST on Income", TaxType: "OUTPUT2", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: true },
    { Name: "15% GST on Expenses", TaxType: "INPUT2", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: false },
    { Name: "Zero Rated", TaxType: "ZERORATED", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
    { Name: "No GST", TaxType: "NONE", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
  ],
  US: [
    { Name: "Tax Exempt", TaxType: "NONE", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
    { Name: "Tax on Sales", TaxType: "OUTPUT", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
  ],
};

/**
 * Replaces `fetch` with a small Xero: a token, the organisation, accounts and tax rates,
 * contacts with unique names, invoices and credit notes with Xero's line arithmetic, payments
 * and idempotency keys. `intercept` can answer any call differently, to play refusals,
 * outages and lost answers.
 */
export function createXero(options: { country?: "NZ" | "US"; scopes?: string[]; currencies?: string[] } = {}) {
  resetClient();
  pacing.rateLimitWaitsMs = [0, 0];
  const country = options.country || "NZ";
  const org: Row = { OrganisationID: `org-${country}`, ...ORGS[country], PaymentTerms: { Sales: { Day: 20, Type: "OFFOLLOWINGMONTH" } } };
  const accounts = ACCOUNTS[country].map((row) => ({ ...row }));
  const taxRates = TAX_RATES[country].map((row) => ({ ...row }));
  const currencies = options.currencies || [org.BaseCurrency];
  const scopes = options.scopes || ["accounting.contacts", "accounting.invoices", "accounting.payments", "accounting.settings.read"];

  const contacts: Row[] = [];
  const invoices: Row[] = [];
  const creditNotes: Row[] = [];
  const payments: Row[] = [];
  const calls: XeroCall[] = [];
  const remembered = new Map<string, { body: string; status: number; response: unknown }>();
  const state: {
    intercept?: (call: XeroCall) => Response | Promise<Response> | "lose-answer" | undefined;
    /** Approving an invoice beyond this number is refused, as on Xero's Starter plan */
    approvalLimit?: number;
  } = {};
  let sequence = 0;

  function id(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence.toString().padStart(4, "0")}`;
  }

  function rateOf(taxType: string | undefined): number {
    return Number(taxRates.find((rate) => rate.TaxType === taxType)?.EffectiveRate || 0);
  }

  /** Xero's line arithmetic: line amounts and tax rounded per line */
  function price(doc: Row, invoice: boolean): Response | undefined {
    let subTotal = 0;
    let totalTax = 0;
    for (const line of doc.LineItems) {
      const account = accounts.find((entry) => entry.Code === line.AccountCode);
      if (!account || account.Status !== "ACTIVE" || account.Type === "BANK") {
        return invalid(`Account code '${line.AccountCode}' is not valid, or has been archived.`);
      }
      if (doc.LineAmountTypes !== "NoTax") {
        const rate = taxRates.find((entry) => entry.TaxType === line.TaxType);
        if (!rate || !rate.CanApplyToRevenue) {
          return invalid(`TaxType code '${line.TaxType}' cannot be used with account code '${line.AccountCode}'.`);
        }
      }
      if (line.DiscountAmount !== undefined && !invoice) {
        return invalid("Discounts are not supported on credit notes.");
      }
      const amount = round(round(line.Quantity * line.UnitAmount) - (line.DiscountAmount || 0));
      const rate = doc.LineAmountTypes === "NoTax" ? 0 : rateOf(line.TaxType);
      const tax =
        doc.LineAmountTypes === "Exclusive" ? round((amount * rate) / 100) : doc.LineAmountTypes === "Inclusive" ? round(amount - amount / (1 + rate / 100)) : 0;
      line.LineAmount = amount;
      line.TaxAmount = tax;
      subTotal = round(subTotal + (doc.LineAmountTypes === "Inclusive" ? amount - tax : amount));
      totalTax = round(totalTax + tax);
    }
    doc.SubTotal = subTotal;
    doc.TotalTax = totalTax;
    doc.Total = round(subTotal + totalTax);
    return undefined;
  }

  function createDoc(kind: "Invoices" | "CreditNotes", input: Row): Response {
    const invoice = kind === "Invoices";
    if (!contacts.some((contact) => contact.ContactID === input.Contact?.ContactID)) {
      return invalid("A valid Contact is required.");
    }
    if (!currencies.includes(input.CurrencyCode)) {
      return invalid(`Organisation is not subscribed to currency ${input.CurrencyCode}`);
    }
    const doc: Row = { ...input, LineItems: input.LineItems.map((line: Row) => ({ ...line })), Status: "DRAFT", DateString: `${input.Date}T00:00:00`, Date: xeroDate(input.Date) };
    const refused = price(doc, invoice);
    if (refused) {
      return refused;
    }
    if (invoice) {
      doc.InvoiceID = id("inv");
      doc.InvoiceNumber = `INV-${String(invoices.length + 1).padStart(4, "0")}`;
      doc.AmountPaid = 0;
      doc.AmountDue = doc.Total;
      doc.Payments = [];
      invoices.push(doc);
    } else {
      doc.CreditNoteID = id("cn");
      doc.CreditNoteNumber = `CN-${String(creditNotes.length + 1).padStart(4, "0")}`;
      doc.RemainingCredit = doc.Total;
      creditNotes.push(doc);
    }
    return json(200, { [kind]: [doc] });
  }

  function find(kind: "Invoices" | "CreditNotes", docId: string): Row | undefined {
    return (kind === "Invoices" ? invoices : creditNotes).find((doc) => doc[kind === "Invoices" ? "InvoiceID" : "CreditNoteID"] === docId);
  }

  function changeStatus(kind: "Invoices" | "CreditNotes", docId: string, status: string): Response {
    const doc = find(kind, docId);
    if (!doc) {
      return json(404, { Title: "Not Found", Status: 404 });
    }
    if (status === "AUTHORISED") {
      if (doc.Status === "DRAFT" || doc.Status === "SUBMITTED") {
        const approved = invoices.filter((entry) => entry.Status === "AUTHORISED" || entry.Status === "PAID").length;
        if (kind === "Invoices" && state.approvalLimit !== undefined && approved >= state.approvalLimit) {
          return invalid("You have reached the limit of invoices you can approve.");
        }
        doc.Status = "AUTHORISED";
      }
    } else if (status === "DELETED") {
      if (doc.Status !== "DRAFT" && doc.Status !== "SUBMITTED") {
        return invalid("Only draft documents can be deleted.");
      }
      doc.Status = "DELETED";
    }
    return json(200, { [kind]: [doc] });
  }

  function pay(input: Row): Response {
    const target = input.Invoice ? find("Invoices", input.Invoice.InvoiceID) : find("CreditNotes", input.CreditNote?.CreditNoteID);
    if (!target) {
      return invalid("The document could not be found.");
    }
    if (target.Status !== "AUTHORISED") {
      return invalid("Payments can only be made against Authorised documents");
    }
    const account = accounts.find((entry) => entry.AccountID === input.Account?.AccountID);
    if (!account || (account.Type !== "BANK" && account.EnablePaymentsToAccount !== true)) {
      return invalid("Account type is invalid for making a payment to/from");
    }
    const due = input.Invoice ? target.AmountDue : target.RemainingCredit;
    if (input.Amount > due + 1e-9) {
      return invalid("Payment amount exceeds the amount outstanding on this document");
    }
    const payment = { PaymentID: id("pay"), ...input };
    payments.push(payment);
    target.Payments = [...(target.Payments || []), { PaymentID: payment.PaymentID, Amount: input.Amount, Reference: input.Reference || "" }];
    if (input.Invoice) {
      target.AmountPaid = round(target.AmountPaid + input.Amount);
      target.AmountDue = round(target.Total - target.AmountPaid);
      target.Status = target.AmountDue <= 0 ? "PAID" : target.Status;
    } else {
      target.RemainingCredit = round(target.RemainingCredit - input.Amount);
      target.Status = target.RemainingCredit <= 0 ? "PAID" : target.Status;
    }
    return json(200, { Payments: [payment] });
  }

  /** Values of a where clause such as `Field=="value"` */
  function whereValue(where: string, field: string): string | undefined {
    const match = new RegExp(`${field.replace(".", "\\.")}==(?:guid\\()?"((?:[^"\\\\]|\\\\.)*)"`).exec(where);
    return match ? match[1].replace(/\\(.)/g, "$1") : undefined;
  }

  function route(call: XeroCall): Response {
    const [, collection, docId] = call.path.split("/");
    const body = call.body || {};
    switch (`${call.method} ${collection}${docId ? "/:id" : ""}`) {
      case "GET Organisation":
        return json(200, { Organisations: [org] });
      case "GET Accounts":
        return json(200, { Accounts: accounts });
      case "GET TaxRates":
        return json(200, { TaxRates: taxRates });
      case "GET Contacts": {
        const where = call.query.get("where") || "";
        const number = whereValue(where, "ContactNumber");
        const email = whereValue(where, "EmailAddress");
        const found = contacts.filter(
          (contact) =>
            contact.ContactStatus === "ACTIVE" &&
            ((number && contact.ContactNumber === number) || (email && (contact.EmailAddress || "").toLowerCase() === email.toLowerCase())),
        );
        return json(200, { Contacts: found });
      }
      case "GET Contacts/:id": {
        const contact = contacts.find((entry) => entry.ContactID === docId);
        return contact ? json(200, { Contacts: [contact] }) : json(404, { Title: "Not Found", Status: 404 });
      }
      case "PUT Contacts": {
        const input = body.Contacts[0];
        if (contacts.some((contact) => contact.ContactStatus === "ACTIVE" && contact.Name.toLowerCase() === input.Name.toLowerCase())) {
          return invalid(`The contact name ${input.Name} is already assigned to another contact. The contact name must be unique across all active contacts.`);
        }
        const contact = { ContactID: id("contact"), ContactStatus: "ACTIVE", ...input };
        contacts.push(contact);
        return json(200, { Contacts: [contact] });
      }
      case "PUT Invoices":
      case "PUT CreditNotes":
        return createDoc(collection as "Invoices" | "CreditNotes", body[collection][0]);
      case "GET Invoices/:id":
      case "GET CreditNotes/:id": {
        const doc = find(collection as "Invoices" | "CreditNotes", docId);
        return doc ? json(200, { [collection]: [doc] }) : json(404, { Title: "Not Found", Status: 404 });
      }
      case "GET Invoices":
      case "GET CreditNotes": {
        const where = call.query.get("where") || "";
        const contactId = whereValue(where, "Contact.ContactID");
        const reference = whereValue(where, "Reference");
        const docs = (collection === "Invoices" ? invoices : creditNotes).filter(
          (doc) => doc.Contact.ContactID === contactId && doc.Reference === reference && doc.Status !== "DELETED" && doc.Status !== "VOIDED",
        );
        return json(200, { [collection]: [...docs].reverse() });
      }
      case "POST Invoices/:id":
      case "POST CreditNotes/:id":
        return changeStatus(collection as "Invoices" | "CreditNotes", docId, body[collection][0].Status);
      case "PUT Payments":
        return pay(body.Payments[0]);
      default:
        throw new Error(`The fake Xero does not know ${call.method} ${call.path}`);
    }
  }

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.hostname === "identity.xero.com") {
      const expected = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
      if (headers.get("Authorization") !== expected) {
        return json(400, { error: "invalid_client" });
      }
      return json(200, { access_token: "token-1", expires_in: 1800, token_type: "Bearer", scope: scopes.join(" ") });
    }
    if (headers.get("Authorization") !== "Bearer token-1") {
      return json(401, { Title: "Unauthorized", Status: 401, Detail: "TokenExpired" });
    }
    const call: XeroCall = {
      method: init.method || "GET",
      path: url.pathname.replace("/api.xro/2.0", ""),
      query: url.searchParams,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      key: headers.get("Idempotency-Key"),
    };
    calls.push(call);

    const intercepted = state.intercept?.(call);
    if (intercepted instanceof Response || intercepted instanceof Promise) {
      return intercepted;
    }

    if (call.key && call.method !== "GET") {
      const seen = remembered.get(call.key);
      const sent = JSON.stringify([call.method, call.path, call.body]);
      if (seen) {
        if (seen.body !== sent) {
          return invalid(`Idempotency Key: ${call.key} is used with a different request.`);
        }
        return json(seen.status, seen.response);
      }
      const response = route(call);
      const copy = await response.clone().json();
      remembered.set(call.key, { body: sent, status: response.status, response: copy });
      if (intercepted === "lose-answer") {
        throw new TypeError("Network connection lost");
      }
      return response;
    }
    const response = route(call);
    if (intercepted === "lose-answer") {
      throw new TypeError("Network connection lost");
    }
    return response;
  }));

  return {
    org,
    accounts,
    taxRates,
    contacts,
    invoices,
    creditNotes,
    payments,
    calls,
    state,
    json,
    writes: () => calls.filter((call) => call.method !== "GET"),
  };
}
