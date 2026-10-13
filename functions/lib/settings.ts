/** The app's settings as the merchant saved them. Groups are the file names in settings/ */
export interface Settings {
  /** The app's record id in this store */
  id?: string;
  connection?: {
    client_id?: string;
    client_secret?: string;
    enabled?: boolean;
    /** The Xero organisation the connection belongs to, saved by Test connection */
    organisation?: string | null;
  };
  invoices?: {
    /** "authorised" creates approved invoices. Anything else, a missing value included, creates drafts */
    status?: "draft" | "authorised" | null;
    /** Code or name of the Xero account that item sales are posted to */
    sales_account?: string | null;
    /** Code or name of the Xero account for shipping. Empty: the sales account */
    shipping_account?: string | null;
    credit_notes?: boolean | null;
  };
  taxes?: {
    /** Xero tax rates for the rates charged in Swell, where matching by rate is not enough */
    rates?: { rate?: number | string | null; tax_rate?: string | null }[] | null;
    /** US organisations: code or name of the account the sales tax line is posted to */
    sales_tax_account?: string | null;
  };
  payments?: {
    /** Code or name of the Xero account that shop payments are paid into. Empty: nothing is recorded */
    account?: string | null;
    /** Payment methods that are paid into another account, or not recorded at all */
    exceptions?: { method?: string | null; account?: string | null }[] | null;
  };
}

/** The part of the store client that functions and workflows share */
export interface StoreClient {
  settings(): Promise<unknown>;
  get(path: string, data?: any): Promise<unknown>;
  post(path: string, data?: any): Promise<unknown>;
  put(path: string, data?: any): Promise<unknown>;
  delete(path: string, data?: any): Promise<unknown>;
}

export function approves(settings: Settings): boolean {
  return settings.invoices?.status === "authorised";
}

export function creditNotesEnabled(settings: Settings): boolean {
  return settings.invoices?.credit_notes !== false;
}

export function credentials(settings: Settings): { clientId: string; clientSecret: string } {
  return {
    clientId: (settings.connection?.client_id || "").trim(),
    clientSecret: (settings.connection?.client_secret || "").trim(),
  };
}
