/**
 * Turns a Swell order into a Xero invoice.
 *
 * Xero computes the tax of each line itself from the line's tax rate, rounded to the cent.
 * Swell computes tax per item with four decimals and rounds only the order total. The two
 * agree most of the time and differ by a cent some of the time, so the invoice is built to
 * give the order's total to the cent:
 *
 * - A store with prices before tax gets a tax-exclusive invoice when Xero's calculation
 *   gives the order total. When it would be a cent off, the same lines are sent as amounts
 *   including tax, whose sum is the total by construction.
 * - A store with prices including tax gets a tax-inclusive invoice.
 * - US organisations keep sales tax apart: Xero's US sales tax rates cannot be used through
 *   the API, so the lines carry no tax and the order's tax is one line of its own, on the
 *   account the merchant names.
 * - Discounts are shown on the line they belong to, so the unit prices on the invoice are
 *   the prices the customer saw.
 *
 * The calculation here only chooses the layout. What decides is Xero's own total on the
 * draft, which the caller compares with the order before the invoice is approved.
 */

import { divideRounded, formatCents, microsToCents, rateToBasisPoints, toCents, toMicros } from "./money";
import { Problem } from "./problem";
import type { SwellRecord } from "./problem";
import { chooseTaxRate } from "./tax";
import type { TaxChoice } from "./tax";
import type { Settings } from "./settings";
import type { ContactInput, LineItem, TaxRate } from "./xero";

export interface Line {
  description: string;
  quantity: number;
  /** Price before discount, in cents, as the invoice states it (with or without tax) */
  listCents: number;
  /** What the line comes to after discount, in cents */
  cents: number;
  accountCode: string;
  taxType?: string;
  /** Tax rate in percent, for the calculation */
  rate: number;
}

export interface Layout {
  lineAmountTypes: "Exclusive" | "Inclusive" | "NoTax";
  lines: Line[];
}

export interface BuiltInvoice {
  /** The layout to send first, and the one to send when Xero's total for the first is not the order's */
  layout: Layout;
  fallback?: Layout;
  /** The order total in cents, which the draft has to show */
  totalCents: number;
  currency: string;
  reference: string;
  contact: ContactInput;
  /** Orders with the same key share one Xero contact */
  contactKey: string;
  customerName: string;
  customerEmail?: string;
  /** The tax rates used, for the record */
  taxNote: string;
}

export interface BuildOptions {
  salesAccount: string;
  shippingAccount: string;
  /** US organisations: the account the sales tax line is posted to. Absent elsewhere */
  salesTaxAccount?: string;
  /** True for a US organisation */
  separateTax: boolean;
  taxRates: TaxRate[];
  settings: Settings;
}

interface Component {
  kind: "item" | "shipping";
  /** Nothing charged and no rate declared: the line takes the order's main rate */
  free?: boolean;
  description: string;
  quantity: number;
  rate: number;
  taxIncluded: boolean;
  /** Price before discount, as the store states it (with or without tax), in micros */
  before: number;
  discount: number;
  tax: number;
}

/** A rate has at most two decimals; rates within rounding of a half step are that step */
function tidyRate(rate: number): number {
  const half = Math.round(rate * 2) / 2;
  return Math.abs(rate - half) < 0.15 ? half : Math.round(rate * 100) / 100;
}

/**
 * The tax rate of an order line. Swell names the rule that taxed each item; the rate comes
 * from there and is checked against the tax actually charged. Imported orders carry no
 * rates, so the charged tax decides when the two disagree.
 */
function findRate(declared: number | undefined, component: Omit<Component, "rate">): number {
  const base = component.before - component.discount;
  if (base <= 0) {
    return declared ?? 0;
  }
  if (component.tax <= 0) {
    return 0;
  }
  const net = component.taxIncluded ? base - component.tax : base;
  const charged = net > 0 ? (component.tax / net) * 100 : 0;
  if (declared !== undefined && Math.abs(declared - charged) < 0.15) {
    return declared;
  }
  return tidyRate(charged);
}

function declaredRate(order: SwellRecord, ids: string[] | undefined, shipping: boolean): number | undefined {
  const taxes: SwellRecord[] = Array.isArray(order.taxes) ? order.taxes : [];
  const applied = shipping ? taxes.filter((tax) => tax.shipping) : taxes.filter((tax) => ids?.includes(tax.id));
  if (applied.length === 0 || applied.some((tax) => typeof tax.rate !== "number")) {
    return undefined;
  }
  return applied.reduce((sum, tax) => sum + tax.rate, 0);
}

function describeOptions(item: SwellRecord): string | undefined {
  if (item.variant_name || !Array.isArray(item.options)) {
    return undefined;
  }
  const parts = item.options
    .filter((option: SwellRecord) => option?.name && option?.value !== undefined && option?.value !== null)
    .map((option: SwellRecord) => `${option.name}: ${option.value}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function readComponents(order: SwellRecord): Component[] {
  const components: Component[] = [];

  for (const item of Array.isArray(order.items) ? order.items : []) {
    const quantity = Number(item.quantity) || 0;
    if (quantity <= 0) {
      continue;
    }
    const before = item.price_total !== undefined && item.price_total !== null
      ? toMicros(item.price_total)
      : toMicros(item.price) * quantity;
    const name = [item.product_name || "Item", item.variant_name].filter(Boolean).join(" - ");
    const sku = item.variant?.sku || item.product?.sku || item.sku;
    const base = {
      kind: "item" as const,
      description: [name, describeOptions(item), sku ? `SKU ${sku}` : undefined].filter(Boolean).join("\n").slice(0, 4000),
      quantity,
      taxIncluded: Boolean(order.item_tax_included),
      before,
      discount: Math.min(toMicros(item.discount_total), before),
      tax: toMicros(item.tax_total),
    };
    const ids = Array.isArray(item.taxes) ? item.taxes.map((tax: SwellRecord) => tax.id) : undefined;
    const declared = declaredRate(order, ids, false);
    components.push({ ...base, rate: findRate(declared, base), free: declared === undefined && base.before - base.discount <= 0 });
  }

  const shipmentPrice = toMicros(order.shipment_price);
  if (shipmentPrice > 0) {
    const service = order.shipping?.service_name;
    const base = {
      kind: "shipping" as const,
      description: service ? `Shipping: ${service}` : "Shipping",
      quantity: 1,
      taxIncluded: Boolean(order.shipment_tax_included),
      before: shipmentPrice,
      discount: Math.min(toMicros(order.shipment_discount), shipmentPrice),
      tax: toMicros(order.shipment_tax),
    };
    components.push({ ...base, rate: findRate(declaredRate(order, undefined, true), base) });
  }

  return components;
}

/**
 * Splits `total` cents over the components in proportion to their exact amounts in micros,
 * so that the parts are whole cents and add up to exactly `total`. Returns nothing when the
 * exact amounts do not come to `total` within a cent per component.
 */
function settle(exact: number[], total: number): number[] | undefined {
  const parts = exact.map((micros) => Math.floor(micros / 100));
  let left = total - parts.reduce((a, b) => a + b, 0);
  if (left < 0 || left > exact.length) {
    return undefined;
  }
  const byLoss = exact
    .map((micros, index) => ({ index, lost: micros - Math.floor(micros / 100) * 100 }))
    .sort((a, b) => b.lost - a.lost || a.index - b.index);
  for (let i = 0; left > 0; i++, left--) {
    parts[byLoss[i].index] += 1;
  }
  return parts;
}

function accountFor(component: Component, options: BuildOptions): string {
  return component.kind === "shipping" ? options.shippingAccount : options.salesAccount;
}

/** Lines with the store's own net prices. Xero adds the tax, so the total has to be checked */
function linesExclusive(components: Component[], choices: TaxChoice[], options: BuildOptions): Line[] {
  return components.map((component, index) => {
    const listCents = microsToCents(component.before);
    return {
      description: component.description,
      quantity: component.quantity,
      listCents,
      cents: listCents - microsToCents(component.discount),
      accountCode: accountFor(component, options),
      taxType: choices[index].taxType,
      rate: component.rate,
    };
  });
}

/** Lines with amounts that include tax and add up to exactly `totalCents` */
function linesInclusive(components: Component[], choices: TaxChoice[], totalCents: number, options: BuildOptions): Line[] | undefined {
  const exact = components.map((c) => c.before - c.discount + (c.taxIncluded ? 0 : c.tax));
  const after = settle(exact, totalCents);
  if (!after) {
    return undefined;
  }
  return components.map((component, index) => {
    const listed = component.taxIncluded
      ? microsToCents(component.before)
      : divideRounded(component.before * (10000 + rateToBasisPoints(component.rate)), 1000000);
    return {
      description: component.description,
      quantity: component.quantity,
      listCents: component.discount > 0 ? Math.max(listed, after[index]) : after[index],
      cents: after[index],
      accountCode: accountFor(component, options),
      taxType: choices[index].taxType,
      rate: component.rate,
    };
  });
}

/** US: lines without tax, and the order's tax as a line of its own */
function linesSeparateTax(components: Component[], totalCents: number, options: BuildOptions, order: SwellRecord): Line[] | undefined {
  const taxMicros = components.reduce((sum, component) => sum + component.tax, 0);
  const taxCents = microsToCents(taxMicros);
  const exact = components.map((c) => c.before - c.discount - (c.taxIncluded ? c.tax : 0));
  const net = settle(exact, totalCents - taxCents);
  if (!net) {
    return undefined;
  }
  const lines: Line[] = components.map((component, index) => {
    const listed = component.taxIncluded ? net[index] : microsToCents(component.before);
    return {
      description: component.description,
      quantity: component.quantity,
      listCents: Math.max(listed, net[index]),
      cents: net[index],
      accountCode: accountFor(component, options),
      rate: 0,
    };
  });
  if (taxCents > 0) {
    if (!options.salesTaxAccount) {
      throw new Problem(
        "failed",
        "no_tax_account",
        "The order was charged sales tax, and no Xero account for sales tax is set. Name the account under Tax rates in the app's settings (for example your Sales Tax Payable account), then retry.",
      );
    }
    const names = [...new Set((Array.isArray(order.taxes) ? order.taxes : []).map((tax: SwellRecord) => tax.name).filter(Boolean))];
    lines.push({
      description: names.length > 0 ? `Sales tax: ${names.join(", ")}` : "Sales tax",
      quantity: 1,
      listCents: taxCents,
      cents: taxCents,
      accountCode: options.salesTaxAccount,
      rate: 0,
    });
  }
  return lines;
}

/** Xero's own calculation, line by line. Amounts in cents */
export function simulate(layout: Layout): { total: number; tax: number } {
  let total = 0;
  let tax = 0;
  for (const line of layout.lines) {
    if (layout.lineAmountTypes === "Exclusive") {
      const lineTax = divideRounded(line.cents * rateToBasisPoints(line.rate), 10000);
      total += line.cents + lineTax;
      tax += lineTax;
    } else {
      total += line.cents;
      if (layout.lineAmountTypes === "Inclusive") {
        tax += line.cents - divideRounded(line.cents * 10000, 10000 + rateToBasisPoints(line.rate));
      }
    }
  }
  return { total, tax };
}

/** True when Xero's rounding of a line's tax could go either way: exactly half a cent */
function halfCent(layout: Layout): boolean {
  return layout.lines.some((line) => (line.cents * rateToBasisPoints(line.rate)) % 10000 === 5000);
}

/**
 * The line as Xero takes it. The unit price is the list price; what was taken off is the
 * discount. A quantity whose unit price has no exact four-decimal value becomes one line
 * for the lot, so that Xero's line amount is exactly the line's.
 */
export function toLineItem(line: Line, discounts: boolean): LineItem {
  const listCents = discounts ? Math.max(line.listCents, line.cents) : line.cents;
  const discount = listCents - line.cents;
  const unitMicros = Math.round((listCents * 100) / line.quantity);
  const exact = unitMicros * line.quantity === listCents * 100;
  return {
    Description: exact || line.quantity === 1 ? line.description : `${line.quantity} x ${line.description}`.slice(0, 4000),
    Quantity: exact ? line.quantity : 1,
    UnitAmount: (exact ? unitMicros : listCents * 100) / 10000,
    AccountCode: line.accountCode,
    ...(line.taxType ? { TaxType: line.taxType } : {}),
    ...(discount > 0 ? { DiscountAmount: discount / 100 } : {}),
  };
}

function splitName(name: string): { FirstName?: string; LastName?: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return words.length === 1 ? { FirstName: words[0] } : {};
  }
  return { FirstName: words.slice(0, -1).join(" ").slice(0, 255), LastName: words[words.length - 1].slice(0, 255) };
}

/** A name Xero accepts: no angle brackets, no leading, trailing or repeated spaces */
export function contactName(value: string): string {
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 255);
}

function validEmail(value: string | undefined): string | undefined {
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.slice(0, 255) : undefined;
}

function readRecipient(order: SwellRecord) {
  const billing: SwellRecord = order.billing || {};
  const shipping: SwellRecord = order.shipping || {};
  const source = billing.address1 || billing.country ? billing : shipping;
  const account: SwellRecord = order.account || {};

  const person = contactName(
    String(
      source.name ||
        [source.first_name, source.last_name].filter(Boolean).join(" ") ||
        billing.name ||
        shipping.name ||
        account.name ||
        [account.first_name, account.last_name].filter(Boolean).join(" ") ||
        "",
    ),
  );
  const company = contactName(String(source.company || ""));
  const email = validEmail(String(account.email || order.account_email || "").trim().toLowerCase() || undefined);
  const phone = String(source.phone || account.phone || "").trim();
  return { person, company, email, phone, source };
}

/** What rules an order out before Xero is asked anything */
export function checkOrder(order: SwellRecord): void {
  if (order.draft) {
    throw new Problem("failed", "draft", "The order is a draft. Place it first.");
  }
  if (!order.currency) {
    throw new Problem("failed", "no_currency", "The order has no currency.");
  }
}

/**
 * Builds the invoice for an order, or throws a Problem that says why there is none.
 * The order needs its `account` expanded for the customer's e-mail address.
 */
export function buildInvoice(order: SwellRecord, options: BuildOptions): BuiltInvoice {
  checkOrder(order);

  const recipient = readRecipient(order);
  const customerName = recipient.company || recipient.person || recipient.email || "";
  if (!customerName) {
    throw new Problem("failed", "no_customer", "The order has no customer name or e-mail address.");
  }

  const components = readComponents(order);
  if (!components.some((component) => component.kind === "item")) {
    throw new Problem("failed", "no_items", "The order has no items.");
  }

  const currency = String(order.currency).toUpperCase();
  const totalCents = toCents(order.grand_total);
  let layout: Layout | undefined;
  let fallback: Layout | undefined;
  let taxNote: string;

  if (options.separateTax) {
    const lines = linesSeparateTax(components, totalCents, options, order);
    layout = lines && { lineAmountTypes: "NoTax", lines };
    taxNote = components.some((component) => component.tax > 0) ? "Sales tax on its own line" : "No sales tax";
  } else {
    // A line worth nothing needs a tax rate all the same. The order's main rate is one that is
    // known to work, where 0 % can be ambiguous in Xero
    const charged = components.filter((component) => !component.free);
    const main = charged.length > 0 ? Math.max(...charged.map((component) => component.rate)) : 0;
    const rated = components.map((component) => (component.free ? { ...component, rate: main } : component));
    const choices = rated.map((component) => chooseTaxRate(component.rate, options.taxRates, options.settings));
    const inclusive = linesInclusive(rated, choices, totalCents, options);
    const gross = inclusive && { lineAmountTypes: "Inclusive" as const, lines: inclusive };
    if (rated.every((component) => !component.taxIncluded)) {
      const net: Layout = { lineAmountTypes: "Exclusive", lines: linesExclusive(rated, choices, options) };
      if (simulate(net).total === totalCents && !halfCent(net)) {
        layout = net;
        fallback = gross;
      }
    }
    layout = layout || gross;
    taxNote = [...new Map(choices.map((choice) => [choice.taxType, choice.name])).values()].join(", ");
  }

  if (!layout || simulate(layout).total !== totalCents) {
    throw new Problem(
      "failed",
      "total_mismatch",
      `The order's items, shipping, discounts and tax do not add up to its total of ${formatCents(totalCents)} ${currency}, so an invoice for exactly that amount cannot be built. Create this invoice in Xero by hand.`,
    );
  }

  const source = recipient.source;
  const address = {
    AddressType: "POBOX" as const,
    ...(source.address1 ? { AddressLine1: String(source.address1).slice(0, 500) } : {}),
    ...(source.address2 ? { AddressLine2: String(source.address2).slice(0, 500) } : {}),
    ...(source.city ? { City: String(source.city).slice(0, 255) } : {}),
    ...(source.state ? { Region: String(source.state).slice(0, 255) } : {}),
    ...(source.zip ? { PostalCode: String(source.zip).slice(0, 50) } : {}),
    ...(source.country ? { Country: String(source.country).slice(0, 50) } : {}),
    ...(recipient.company && recipient.person ? { AttentionTo: recipient.person } : {}),
  };
  const number = String(order.number || order.id);

  return {
    layout,
    ...(fallback ? { fallback } : {}),
    totalCents,
    currency,
    reference: number,
    contact: {
      Name: customerName,
      ...(recipient.person ? splitName(recipient.person) : {}),
      ...(recipient.email ? { EmailAddress: recipient.email } : {}),
      ...(order.account_id ? { ContactNumber: String(order.account_id).slice(0, 50) } : {}),
      ...(Object.keys(address).length > 1 ? { Addresses: [address] } : {}),
      ...(recipient.phone ? { Phones: [{ PhoneType: "DEFAULT" as const, PhoneNumber: recipient.phone.slice(0, 50) }] } : {}),
    },
    // An order with neither an account nor an e-mail address stands alone: it must not be
    // filed under another customer's contact
    contactKey: order.account_id || recipient.email || `order:${order.id}`,
    customerName,
    customerEmail: recipient.email,
    taxNote,
  };
}
