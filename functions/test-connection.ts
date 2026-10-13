import { clearAlert } from "./lib/alerts";
import { findAccount } from "./lib/payments";
import { approves, credentials } from "./lib/settings";
import type { Settings } from "./lib/settings";
import { describeTaxes } from "./lib/tax";
import { NEEDED_SCOPES, XeroError, dropToken, forgetSettings, getAccounts, getOrganisation, getTaxRates, grantedScopes } from "./lib/xero";
import type { Account, Api, Organisation, TaxRate } from "./lib/xero";

export const config: SwellConfig = {
  description: "Check the saved custom connection with Xero and show how the organisation is set up",
  action: true,
};

function label(account: Account): string {
  return account.code ? `${account.code} ${account.name}` : account.name;
}

function list(accounts: Account[], limit = 8): string {
  const names = accounts.slice(0, limit).map(label);
  return accounts.length > limit ? `${names.join(", ")} and ${accounts.length - limit} more` : names.join(", ");
}

/** The scopes the connection lacks, in the merchant's words */
export function describeScopes(granted: string[]): string | undefined {
  if (granted.length === 0) {
    return undefined;
  }
  const missing = NEEDED_SCOPES.filter((need) => !granted.includes(need.scope) && !granted.includes(need.broad));
  if (missing.length === 0) {
    return undefined;
  }
  return `The custom connection lacks ${missing.map((need) => `${need.scope} (for ${need.for})`).join(", ")}. Add the scopes in Xero's developer portal and have the connection authorised again.`;
}

/** How the account settings match the organisation's chart of accounts */
export function describeAccounts(settings: Settings, org: Organisation, accounts: Account[]): string[] {
  const active = accounts.filter((account) => account.status === "ACTIVE");
  const income = active.filter((account) => account.class === "REVENUE" && account.code);
  const paying = active.filter((account) => account.takesPayments);
  const notes: string[] = [];

  const lineAccount = (value: string | null | undefined, what: string) => {
    const wanted = (value || "").trim();
    const account = wanted ? findAccount(accounts, wanted) : undefined;
    if (!wanted) {
      notes.push(`Name the account for ${what}. Income accounts in Xero: ${list(income)}.`);
    } else if (!account || !account.code || account.type === "BANK") {
      notes.push(`Xero has no account "${wanted}" that invoices can use for ${what}. Income accounts in Xero: ${list(income)}.`);
    } else {
      notes.push(`${what[0].toUpperCase()}${what.slice(1)} go to ${label(account)}.`);
    }
  };
  lineAccount(settings.invoices?.sales_account, "sales");
  if ((settings.invoices?.shipping_account || "").trim()) {
    lineAccount(settings.invoices?.shipping_account, "shipping");
  }
  if (org.countryCode === "US") {
    const wanted = (settings.taxes?.sales_tax_account || "").trim();
    const account = wanted ? findAccount(accounts, wanted) : undefined;
    const liabilities = active.filter((entry) => entry.class === "LIABILITY" && entry.code);
    if (!account || !account.code) {
      notes.push(
        `${wanted ? `Xero has no account "${wanted}" for sales tax.` : "Orders with sales tax need an account for it, under Tax rates."} Liability accounts in Xero: ${list(liabilities)}.`,
      );
    } else {
      notes.push(`Sales tax goes on its own line, to ${label(account)}.`);
    }
  }

  const names = [settings.payments?.account, ...(settings.payments?.exceptions || []).map((row) => row?.account)]
    .map((name) => (name || "").trim())
    .filter((name, index, all) => name && all.indexOf(name) === index);
  const available = paying.length > 0 ? `Accounts in Xero that take payments: ${list(paying)}.` : "Xero has no account that takes payments: add a bank account.";
  if (names.length === 0) {
    notes.push(`Payments are not recorded: name an account under Payments. ${available}`);
  } else {
    const unknown = names.filter((name) => !findAccount(accounts, name));
    const refusing = names.filter((name) => {
      const account = findAccount(accounts, name);
      return account && !account.takesPayments;
    });
    if (unknown.length > 0) {
      notes.push(`Xero has no account ${unknown.map((name) => `"${name}"`).join(", ")}. ${available}`);
    } else if (refusing.length > 0) {
      notes.push(`${refusing.map((name) => `"${name}"`).join(", ")} does not take payments in Xero. ${available}`);
    } else {
      notes.push(`Payments are recorded on ${names.map((name) => label(findAccount(accounts, name) as Account)).join(", ")}.`);
    }
  }
  return notes;
}

export default async function (req: SwellRequest) {
  const started = Date.now();
  const settings = ((await req.swell.settings()) || {}) as Settings;
  const { clientId, clientSecret } = credentials(settings);
  if (!clientId || !clientSecret) {
    throw new SwellError("Enter the client ID and the client secret of your Xero custom connection, save the settings, then test again.", { status: 400 });
  }

  // The merchant waits for the answer, and a function has ten seconds
  const api: Api = { clientId, clientSecret, abortAt: started + 8000 };
  // A test after the connection's scopes or organisation changed needs a new token, and
  // fresh settings
  dropToken(api);
  forgetSettings(api);
  let org: Organisation;
  let accounts: Account[];
  let taxRates: TaxRate[];
  let scopes: string[];
  try {
    scopes = await grantedScopes(api);
    [org, accounts, taxRates] = await Promise.all([getOrganisation(api), getAccounts(api), getTaxRates(api)]);
  } catch (err) {
    if (err instanceof XeroError && (err.connection || err.kind === "rejected")) {
      throw new SwellError(err.message, { status: 400 });
    }
    throw new SwellError(`${(err as Error).message} Try again in a minute.`, { status: 502 });
  }

  if (settings.connection?.organisation !== org.name) {
    try {
      await req.swell.put(`/settings/${req.appId}`, { connection: { organisation: org.name || null } });
    } catch (err) {
      // Only the display of the organisation's name depends on it
      console.error("Unable to save the Xero organisation's name", (err as Error).message);
    }
  }
  await clearAlert(req.swell, "connection");

  const waiting = (await req.swell.get("/documents", { where: { status: "failed" }, limit: 1 })) as { count?: number };
  const parts = [
    `Connected to ${org.name || "your Xero organisation"} (${org.countryCode || "?"}, ${org.baseCurrency || "?"}).`,
    describeScopes(scopes),
    approves(settings) ? "Invoices are created approved." : "Invoices are created as drafts.",
    ...describeAccounts(settings, org, accounts),
    ...(org.countryCode === "US" ? [] : describeTaxes(taxRates, settings)),
  ];
  if (settings.connection?.enabled !== true) {
    parts.push('Turn on "Send paid orders and refunds to Xero" to start.');
  }
  if ((waiting?.count || 0) > 0) {
    parts.push(`${waiting.count} ${waiting.count === 1 ? "document needs" : "documents need"} attention: choose Retry failed documents in the Actions menu.`);
  }
  return { message: parts.filter(Boolean).join(" ") };
}
