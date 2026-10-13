/**
 * Client for the Xero Accounting API, reached through a custom connection.
 *
 * What shapes it:
 * - A custom connection belongs to one organisation. Its client ID and secret buy an access
 *   token for 30 minutes (client credentials grant). Tokens are kept per worker until shortly
 *   before they expire.
 * - Writes carry an idempotency key, so a write repeated after a lost answer is not done twice.
 *   When a write ends without an answer (timeout, 5xx), the error is marked `uncertain`.
 * - Xero allows 60 calls a minute and 5 at a time per organisation. A 429 is waited out
 *   twice, for as long as Xero says or a second or two, when that fits in a few seconds;
 *   otherwise the caller tries again later.
 */

const TOKEN_URL = "https://identity.xero.com/connect/token";
const API_URL = "https://api.xero.com/api.xro/2.0";

/**
 * Without a scope, Xero grants a custom connection the scopes it was authorised with.
 * Should Xero insist on naming them, the granular scopes of connections made since April
 * 2026 come next, then the broad ones of older connections.
 */
const SCOPE_REQUESTS = [
  undefined,
  "accounting.contacts accounting.invoices accounting.payments accounting.settings.read",
  "accounting.contacts accounting.transactions accounting.settings",
];

/** The scopes the app needs, each with the older broad scope that covers it */
export const NEEDED_SCOPES: { scope: string; broad: string; for: string }[] = [
  { scope: "accounting.contacts", broad: "accounting.contacts", for: "customers" },
  { scope: "accounting.invoices", broad: "accounting.transactions", for: "invoices and credit notes" },
  { scope: "accounting.payments", broad: "accounting.transactions", for: "payments" },
  { scope: "accounting.settings.read", broad: "accounting.settings", for: "accounts and tax rates" },
];

// Settings the app reads for every document. They rarely change, and each read counts
// against the organisation's daily limit of calls
const SETTINGS_TTL_MS = 5 * 60 * 1000;

// One call is cut off before a function's own limit, so the function still has time to
// record what happened. A workflow step has minutes, and no deadline
const TIMEOUT_MS = 15000;
// Refresh a token this long before Xero would refuse it
const TOKEN_MARGIN_MS = 2 * 60 * 1000;

/** Waits before a call that Xero answered with 429 is repeated. Tests set these to zero */
export const pacing = { rateLimitWaitsMs: [1000, 2000], maxRetryAfterMs: 5000 };

export type XeroErrorKind =
  /** The client ID or secret is wrong, or the connection was removed */
  | "credentials"
  /** The connection lacks a scope, or the organisation does not allow the call */
  | "permission"
  /** Xero refuses this data. Sending it again cannot help */
  | "rejected"
  /** 429 after the waits */
  | "rate_limit"
  /** Network failure, timeout, 5xx, or no time left to wait for Xero */
  | "unavailable";

export class XeroError extends Error {
  kind: XeroErrorKind;
  status: number;
  /** True when a write may have been performed although no answer arrived */
  uncertain: boolean;
  /** The refusal in the merchant's terms, when the app knows what it means */
  hint?: string;

  constructor(kind: XeroErrorKind, status: number, message: string, uncertain = false) {
    super(message);
    this.name = "XeroError";
    this.kind = kind;
    this.status = status;
    this.uncertain = uncertain;
  }

  /** True for failures of the connection as a whole, which no single document can fix */
  get connection(): boolean {
    return this.kind === "credentials" || this.kind === "permission";
  }

  /** True when the same call can succeed later without anybody changing anything */
  get temporary(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable";
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

/** How to reach one Xero organisation */
export interface Api {
  clientId: string;
  clientSecret: string;
  /** The moment (ms) by which a call has to be given up, because the function that makes it ends soon after */
  abortAt?: number;
}

export type XeroDocumentStatus = "DRAFT" | "SUBMITTED" | "AUTHORISED" | "PAID" | "VOIDED" | "DELETED";

export interface LineItem {
  Description: string;
  Quantity: number;
  /** Up to four decimals: requests are sent with unitdp=4 */
  UnitAmount: number;
  AccountCode: string;
  /** Left out on documents without tax */
  TaxType?: string;
  /** Invoices only: Xero takes no discounts on credit notes */
  DiscountAmount?: number;
}

export interface InvoiceInput {
  Type: "ACCREC";
  Contact: { ContactID: string };
  /** YYYY-MM-DD */
  Date: string;
  DueDate: string;
  LineAmountTypes: "Exclusive" | "Inclusive" | "NoTax";
  Reference: string;
  CurrencyCode: string;
  Status: "DRAFT";
  LineItems: LineItem[];
}

export interface CreditNoteInput {
  Type: "ACCRECCREDIT";
  Contact: { ContactID: string };
  /** YYYY-MM-DD */
  Date: string;
  LineAmountTypes: "Exclusive" | "Inclusive" | "NoTax";
  Reference: string;
  CurrencyCode: string;
  Status: "DRAFT";
  LineItems: LineItem[];
}

/** An invoice or a credit note as Xero answers it */
export interface XeroDocument {
  id: string;
  number: string | null;
  status: XeroDocumentStatus;
  reference: string | null;
  contactId: string;
  currency: string;
  lineAmountTypes: string;
  subTotal: number;
  totalTax: number;
  total: number;
  /** Invoices: what is paid on it. Credit notes: what was paid out or allocated */
  amountPaid: number;
  amountDue: number;
  /** The document's day, YYYY-MM-DD */
  date: string | null;
  /** The payments on the document, when Xero's answer lists them */
  payments?: { id: string; amount: number; reference: string }[];
  lineItems: (LineItem & { LineAmount: number; TaxAmount: number })[];
}

export interface Organisation {
  id: string;
  name: string;
  baseCurrency: string;
  countryCode: string;
  /** Windows time zone name, as Xero gives it */
  timezone: string;
  shortCode: string;
  /** Sales payment terms of the organisation */
  salesTerms?: { day: number; type: string };
}

export interface Account {
  id: string;
  code: string;
  /** ROUNDING, GST, BANKCURRENCYGAIN and the like, for Xero's own accounts */
  systemAccount?: string;
  name: string;
  type: string;
  class: string;
  status: string;
  /** Bank accounts and accounts with "Enable payments to this account" take payments */
  takesPayments: boolean;
  currency?: string;
}

export interface TaxRate {
  name: string;
  taxType: string;
  status: string;
  rate: number;
  revenue: boolean;
}

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  number: string | null;
}

export interface ContactInput {
  Name: string;
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
  ContactNumber?: string;
  Addresses?: {
    AddressType: "POBOX" | "STREET";
    AddressLine1?: string;
    AddressLine2?: string;
    City?: string;
    Region?: string;
    PostalCode?: string;
    Country?: string;
    AttentionTo?: string;
  }[];
  Phones?: { PhoneType: "DEFAULT"; PhoneNumber: string }[];
}

interface Token {
  value: string;
  expires: number;
  scopes: string[];
}

const tokens = new Map<string, Token>();
const scopeRequests = new Map<string, number>();
const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function remaining(api: Api): number {
  return api.abortAt ? api.abortAt - Date.now() : TIMEOUT_MS;
}

/** Xero's validation messages, joined */
function validationMessages(body: any): string[] {
  const messages: string[] = [];
  for (const element of body?.Elements || []) {
    for (const error of element?.ValidationErrors || []) {
      if (error?.Message) {
        messages.push(String(error.Message));
      }
    }
  }
  return [...new Set(messages)];
}

function describe(body: any, fallback: string): string {
  const messages = validationMessages(body);
  if (messages.length > 0) {
    return messages.join(" ").slice(0, 500);
  }
  const message = body?.Detail ?? body?.Message ?? body?.detail ?? body?.message ?? body?.Title;
  return typeof message === "string" && message ? message.slice(0, 500) : fallback;
}

async function readBody(response: Response): Promise<any> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { Message: text.slice(0, 300) };
  }
}

function lacksScope(headers?: Headers): boolean {
  // Xero spells it "insufficent_scope"
  return /insuff?ici?e?nt_scope/i.test(headers?.get("WWW-Authenticate") || "");
}

function toError(status: number, body: any, write: boolean, headers?: Headers): XeroError {
  switch (status) {
    case 401:
      if (lacksScope(headers)) {
        return new XeroError(
          "permission",
          status,
          "The custom connection lacks a scope the app needs. In Xero's developer portal, give it the scopes listed in the app guide, have the connection authorised again, then test again.",
        );
      }
      return new XeroError("credentials", status, "Xero did not accept the connection. Check the client ID and secret of the custom connection.");
    case 403:
      return new XeroError(
        "permission",
        status,
        "Xero refused access to the organisation: the custom connection was disconnected, or the organisation is no longer active. Check the connection in Xero's developer portal.",
      );
    case 429: {
      const problem = headers?.get("X-Rate-Limit-Problem");
      return new XeroError(
        "rate_limit",
        status,
        problem === "day"
          ? "Xero's daily limit of API calls for the organisation is reached. The app tries again later."
          : "Xero is limiting the number of calls right now. The app tries again in a moment.",
      );
    }
    default:
      if (status >= 500 || status === 0) {
        const offline = status === 503 && /offline|not ?available/i.test(describe(body, ""));
        return new XeroError(
          "unavailable",
          status,
          offline ? "The Xero organisation is offline for maintenance. The app tries again later." : `Xero did not answer properly (${status || "no answer"}).`,
          write,
        );
      }
      return new XeroError("rejected", status, describe(body, `Xero refused the request (${status}).`));
  }
}

function tokenKey(api: Api): string {
  return `${api.clientId}:${api.clientSecret}`;
}

/** Forgets the token, after Xero refused it */
export function dropToken(api: Api): void {
  tokens.delete(tokenKey(api));
}

async function requestToken(api: Api, scope: string | undefined): Promise<{ response: Response; body: any }> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${api.clientId}:${api.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: `grant_type=client_credentials${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`,
      signal: AbortSignal.timeout(Math.max(1000, Math.min(TIMEOUT_MS, remaining(api)))),
    });
  } catch (err) {
    throw new XeroError("unavailable", 0, `Xero could not be reached: ${(err as Error).message}`);
  }
  return { response, body: await readBody(response) };
}

async function getToken(api: Api): Promise<Token> {
  const cached = tokens.get(tokenKey(api));
  if (cached && cached.expires > Date.now() + TOKEN_MARGIN_MS) {
    return cached;
  }
  if (!api.clientId || !api.clientSecret) {
    throw new XeroError("credentials", 0, "Enter the client ID and the client secret of your Xero custom connection, then save.");
  }

  let index = scopeRequests.get(tokenKey(api)) ?? 0;
  let { response, body } = await requestToken(api, SCOPE_REQUESTS[index]);
  while (!body?.access_token && /^invalid_(scope|request)$/.test(String(body?.error || "")) && index < SCOPE_REQUESTS.length - 1) {
    index += 1;
    ({ response, body } = await requestToken(api, SCOPE_REQUESTS[index]));
  }

  if (!response.ok || !body?.access_token) {
    const code = String(body?.error || "");
    if (code === "invalid_client") {
      throw new XeroError("credentials", response.status, "Xero did not accept the client ID and secret. Copy them again from the custom connection in Xero's developer portal.");
    }
    if (code === "unauthorized_client" || code === "invalid_scope") {
      throw new XeroError(
        "permission",
        response.status,
        code === "invalid_scope"
          ? "The custom connection in Xero lacks a scope the app needs. Give it the scopes listed in the app guide, then test again."
          : "Xero has not authorised the custom connection yet. The user it was sent to has to accept it and choose the organisation, then test again.",
      );
    }
    if (response.status >= 500 || response.status === 429) {
      throw new XeroError("unavailable", response.status, `Xero's sign-in service did not answer properly (${response.status}).`);
    }
    throw new XeroError("credentials", response.status, `Xero refused the connection: ${code || describe(body, String(response.status))}.`);
  }
  scopeRequests.set(tokenKey(api), index);
  const token: Token = {
    value: String(body.access_token),
    expires: Date.now() + num(body.expires_in || 1800) * 1000,
    scopes: String(body.scope || "").split(/\s+/).filter(Boolean),
  };
  tokens.set(tokenKey(api), token);
  return token;
}

/** The scopes Xero granted the connection's token */
export async function grantedScopes(api: Api): Promise<string[]> {
  return (await getToken(api)).scopes;
}

/** Reads a setting of the organisation once per few minutes per worker */
function cached<T>(api: Api, name: string, load: () => Promise<T>): Promise<T> {
  const key = `${tokenKey(api)}:${name}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.value as Promise<T>;
  }
  const value = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { expires: Date.now() + SETTINGS_TTL_MS, value });
  return value;
}

/** Forgets the organisation's settings, so the next read asks Xero */
export function forgetSettings(api: Api): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${tokenKey(api)}:`)) {
      cache.delete(key);
    }
  }
}

interface Call {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Sent as Idempotency-Key with writes */
  key?: string;
}

async function xeroRequest(api: Api, call: Call): Promise<any> {
  const write = call.method !== "GET";
  const url = new URL(`${API_URL}${call.path}`);
  for (const [name, value] of Object.entries(call.query || {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }

  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    const left = remaining(api);
    if (left < 1000) {
      throw new XeroError("unavailable", 0, "There was no time left to wait for Xero. The app tries again.", false);
    }
    const token = (await getToken(api)).value;
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: call.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(write ? { "Content-Type": "application/json" } : {}),
          ...(write && call.key ? { "Idempotency-Key": call.key } : {}),
        },
        body: write && call.body !== undefined ? JSON.stringify(call.body) : undefined,
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left)),
      });
    } catch (err) {
      throw new XeroError("unavailable", 0, `Xero could not be reached: ${(err as Error).message}`, write);
    }

    if (response.ok) {
      return readBody(response);
    }
    const body = await readBody(response);
    if (response.status === 401 && !renewed && !lacksScope(response.headers)) {
      // The token may have been revoked or expired early. One new token is worth a try
      dropToken(api);
      renewed = true;
      continue;
    }
    if (response.status === 429 && attempt < pacing.rateLimitWaitsMs.length && response.headers.get("X-Rate-Limit-Problem") !== "day") {
      const retryAfter = num(response.headers.get("Retry-After")) * 1000;
      const delay = Math.max(retryAfter, pacing.rateLimitWaitsMs[attempt]);
      if (delay <= pacing.maxRetryAfterMs && delay < remaining(api) - 1000) {
        await wait(delay);
        continue;
      }
    }
    throw toError(response.status, body, write, response.headers);
  }
}

/** Xero's JSON dates: "/Date(1760313600000+0000)/" */
export function parseXeroDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /\/Date\((-?\d+)/.exec(value);
  if (match) {
    return new Date(Number(match[1])).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDocument(raw: any, kind: "Invoice" | "CreditNote"): XeroDocument {
  const invoice = kind === "Invoice";
  return {
    id: String(invoice ? raw.InvoiceID : raw.CreditNoteID),
    number: (invoice ? raw.InvoiceNumber : raw.CreditNoteNumber) || null,
    status: raw.Status,
    reference: raw.Reference || null,
    contactId: String(raw.Contact?.ContactID || ""),
    currency: String(raw.CurrencyCode || ""),
    lineAmountTypes: String(raw.LineAmountTypes || ""),
    subTotal: num(raw.SubTotal),
    totalTax: num(raw.TotalTax),
    total: num(raw.Total),
    amountPaid: invoice ? num(raw.AmountPaid) : num(raw.Total) - num(raw.RemainingCredit),
    amountDue: invoice ? num(raw.AmountDue) : num(raw.RemainingCredit),
    date: (raw.DateString ? String(raw.DateString) : parseXeroDate(raw.Date) || "").slice(0, 10) || null,
    ...(Array.isArray(raw.Payments)
      ? {
          payments: raw.Payments.map((payment: any) => ({
            id: String(payment.PaymentID || ""),
            amount: num(payment.Amount),
            reference: String(payment.Reference || ""),
          })),
        }
      : {}),
    lineItems: (raw.LineItems || []).map((line: any) => ({
      Description: line.Description || "",
      Quantity: num(line.Quantity),
      UnitAmount: num(line.UnitAmount),
      AccountCode: line.AccountCode || "",
      ...(line.TaxType ? { TaxType: String(line.TaxType) } : {}),
      TaxAmount: num(line.TaxAmount),
      LineAmount: num(line.LineAmount),
    })),
  };
}

function only(body: any, collection: string): any {
  const record = body?.[collection]?.[0];
  if (!record) {
    throw new XeroError("unavailable", 0, `Xero's answer had no ${collection}.`, true);
  }
  return record;
}

/** A where clause value, quoted the way Xero's filter syntax wants it */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function getOrganisation(api: Api): Promise<Organisation> {
  return cached(api, "organisation", () => readOrganisation(api));
}

async function readOrganisation(api: Api): Promise<Organisation> {
  const raw = only(await xeroRequest(api, { method: "GET", path: "/Organisation" }), "Organisations");
  const sales = raw.PaymentTerms?.Sales;
  return {
    id: String(raw.OrganisationID || ""),
    name: String(raw.Name || raw.LegalName || ""),
    baseCurrency: String(raw.BaseCurrency || ""),
    countryCode: String(raw.CountryCode || ""),
    timezone: String(raw.Timezone || ""),
    shortCode: String(raw.ShortCode || ""),
    ...(sales?.Type ? { salesTerms: { day: num(sales.Day), type: String(sales.Type) } } : {}),
  };
}

export function getAccounts(api: Api): Promise<Account[]> {
  return cached(api, "accounts", () => readAccounts(api));
}

async function readAccounts(api: Api): Promise<Account[]> {
  const body = await xeroRequest(api, { method: "GET", path: "/Accounts" });
  return (body?.Accounts || []).map((raw: any) => ({
    id: String(raw.AccountID),
    code: String(raw.Code || ""),
    name: String(raw.Name || ""),
    type: String(raw.Type || ""),
    class: String(raw.Class || ""),
    status: String(raw.Status || ""),
    ...(raw.SystemAccount ? { systemAccount: String(raw.SystemAccount) } : {}),
    takesPayments: raw.Type === "BANK" || raw.EnablePaymentsToAccount === true,
    ...(raw.CurrencyCode ? { currency: String(raw.CurrencyCode) } : {}),
  }));
}

export function getTaxRates(api: Api): Promise<TaxRate[]> {
  return cached(api, "tax-rates", () => readTaxRates(api));
}

async function readTaxRates(api: Api): Promise<TaxRate[]> {
  const body = await xeroRequest(api, { method: "GET", path: "/TaxRates" });
  return (body?.TaxRates || []).map((raw: any) => ({
    name: String(raw.Name || ""),
    taxType: String(raw.TaxType || ""),
    status: String(raw.Status || ""),
    rate: num(raw.EffectiveRate ?? raw.DisplayTaxRate),
    revenue: raw.CanApplyToRevenue === true,
  }));
}

function toContact(raw: any): Contact {
  return {
    id: String(raw.ContactID),
    name: String(raw.Name || ""),
    email: raw.EmailAddress ? String(raw.EmailAddress) : null,
    number: raw.ContactNumber ? String(raw.ContactNumber) : null,
  };
}

/** Active contacts with this contact number (the Swell customer's id) or e-mail address */
export async function findContacts(api: Api, match: { number?: string; email?: string }): Promise<Contact[]> {
  const terms = [
    ...(match.number ? [`ContactNumber==${quote(match.number)}`] : []),
    ...(match.email ? [`EmailAddress==${quote(match.email)}`] : []),
  ];
  if (terms.length === 0) {
    return [];
  }
  const body = await xeroRequest(api, {
    method: "GET",
    path: "/Contacts",
    query: { where: `(${terms.join("||")})&&ContactStatus=="ACTIVE"`, summaryOnly: "true" },
  });
  return (body?.Contacts || []).map(toContact);
}

/** The contact, or nothing when it was deleted or archived */
export async function getContact(api: Api, id: string): Promise<Contact | undefined> {
  try {
    const raw = (await xeroRequest(api, { method: "GET", path: `/Contacts/${id}` }))?.Contacts?.[0];
    return raw && raw.ContactStatus === "ACTIVE" ? toContact(raw) : undefined;
  } catch (err) {
    if (err instanceof XeroError && err.notFound) {
      return undefined;
    }
    throw err;
  }
}

export async function createContact(api: Api, contact: ContactInput, key: string): Promise<Contact> {
  const body = await xeroRequest(api, { method: "PUT", path: "/Contacts", body: { Contacts: [contact] }, key });
  return toContact(only(body, "Contacts"));
}

type Kind = "Invoice" | "CreditNote";

function collection(kind: Kind): string {
  return kind === "Invoice" ? "Invoices" : "CreditNotes";
}

export async function createDocument(api: Api, kind: Kind, input: InvoiceInput | CreditNoteInput, key: string): Promise<XeroDocument> {
  const body = await xeroRequest(api, {
    method: "PUT",
    path: `/${collection(kind)}`,
    query: { unitdp: 4 },
    body: { [collection(kind)]: [input] },
    key,
  });
  return toDocument(only(body, collection(kind)), kind);
}

export async function getDocument(api: Api, kind: Kind, id: string): Promise<XeroDocument> {
  const body = await xeroRequest(api, { method: "GET", path: `/${collection(kind)}/${id}`, query: { unitdp: 4 } });
  return toDocument(only(body, collection(kind)), kind);
}

/** The app's documents with this reference for the contact, newest first. Deleted and voided ones are left out */
export async function findDocuments(api: Api, kind: Kind, contactId: string, reference: string): Promise<XeroDocument[]> {
  const type = kind === "Invoice" ? "ACCREC" : "ACCRECCREDIT";
  const body = await xeroRequest(api, {
    method: "GET",
    path: `/${collection(kind)}`,
    query: {
      where: `Type==${quote(type)}&&Contact.ContactID==guid(${quote(contactId)})&&Reference==${quote(reference)}&&Status!="DELETED"&&Status!="VOIDED"`,
      order: "UpdatedDateUTC DESC",
      unitdp: 4,
    },
  });
  return (body?.[collection(kind)] || []).map((raw: any) => toDocument(raw, kind));
}

/** Approves a draft. An approved document is answered as it is */
export async function approve(api: Api, kind: Kind, id: string, key: string): Promise<XeroDocument> {
  const idField = kind === "Invoice" ? "InvoiceID" : "CreditNoteID";
  const body = await xeroRequest(api, {
    method: "POST",
    path: `/${collection(kind)}/${id}`,
    query: { unitdp: 4 },
    body: { [collection(kind)]: [{ [idField]: id, Status: "AUTHORISED" }] },
    key,
  });
  return toDocument(only(body, collection(kind)), kind);
}

/** Deletes a draft of the app that is not wanted after all. It has no payments */
export async function deleteDraft(api: Api, kind: Kind, id: string): Promise<void> {
  const idField = kind === "Invoice" ? "InvoiceID" : "CreditNoteID";
  await xeroRequest(api, {
    method: "POST",
    path: `/${collection(kind)}/${id}`,
    body: { [collection(kind)]: [{ [idField]: id, Status: "DELETED" }] },
  });
}

export interface PaymentInput {
  /** The invoice paid, or the credit note paid out */
  invoiceId?: string;
  creditNoteId?: string;
  accountId: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
  reference?: string;
}

/** Records a payment on an invoice, or a refund paid out on a credit note */
export async function createPayment(api: Api, payment: PaymentInput, key: string): Promise<void> {
  await xeroRequest(api, {
    method: "PUT",
    path: "/Payments",
    body: {
      Payments: [
        {
          ...(payment.invoiceId ? { Invoice: { InvoiceID: payment.invoiceId } } : { CreditNote: { CreditNoteID: payment.creditNoteId } }),
          Account: { AccountID: payment.accountId },
          Amount: payment.amount,
          Date: payment.date,
          ...(payment.reference ? { Reference: payment.reference.slice(0, 255) } : {}),
        },
      ],
    },
    key,
  });
}

/** The document in Xero's web app. With the organisation's short code the link opens the right organisation */
export function documentLink(kind: Kind, id: string, shortCode?: string): string {
  const path = kind === "Invoice" ? `/AccountsReceivable/View.aspx?InvoiceID=${id}` : `/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${id}`;
  if (!shortCode) {
    return `https://go.xero.com${path}`;
  }
  return `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(shortCode)}&redirecturl=${encodeURIComponent(path)}`;
}

/** Forgets every token and cached setting. Tests start each case from a clean client */
export function resetClient(): void {
  tokens.clear();
  scopeRequests.clear();
  cache.clear();
}
