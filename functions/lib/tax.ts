/**
 * Picks the Xero tax rate for each rate Swell charged.
 *
 * Xero names its tax rates per organisation and country, and several can share a
 * percentage: a UK organisation has Zero Rated Income, Exempt Income and No VAT at 0 %. The
 * app takes the merchant's choice from the settings first, then the one active sales rate
 * with the same percentage. When that is not one rate, the document waits for the merchant
 * to choose.
 */

import { Problem } from "./problem";
import type { Settings } from "./settings";
import type { TaxRate } from "./xero";

export interface TaxChoice {
  taxType: string;
  name: string;
  rate: number;
}

const SAME = 0.005;

function normal(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(4))} %`;
}

/** The sales tax rates Xero offers, active and usable on invoices */
export function salesRates(rates: TaxRate[]): TaxRate[] {
  return rates.filter((rate) => rate.revenue && rate.status === "ACTIVE");
}

/** The merchant's row for this percentage under Tax rates, if any */
function chosenFor(settings: Settings, rate: number): string | undefined {
  const row = (settings.taxes?.rates || []).find((entry) => {
    const value = Number(String(entry?.rate ?? "").replace(",", ".").replace("%", ""));
    return Number.isFinite(value) && String(entry?.rate ?? "").trim() !== "" && Math.abs(value - rate) < SAME;
  });
  return row ? (row.tax_rate || "").trim() || undefined : undefined;
}

/** The Xero tax rate for `rate` percent, or a Problem that says what the merchant has to choose */
export function chooseTaxRate(rate: number, rates: TaxRate[], settings: Settings): TaxChoice {
  const usable = salesRates(rates);
  const chosen = chosenFor(settings, rate);
  if (chosen) {
    const found = usable.find((entry) => normal(entry.name) === normal(chosen) || normal(entry.taxType) === normal(chosen));
    if (!found) {
      throw new Problem(
        "failed",
        "tax_rate_unknown",
        `Xero has no active sales tax rate named "${chosen}", which the app's settings name for ${formatRate(rate)}. Correct the name under Tax rates (Test connection lists Xero's rates), then retry.`,
      );
    }
    return { taxType: found.taxType, name: found.name, rate };
  }

  const matching = usable.filter((entry) => Math.abs(entry.rate - rate) < SAME);
  if (matching.length === 1) {
    return { taxType: matching[0].taxType, name: matching[0].name, rate };
  }
  if (matching.length === 0) {
    throw new Problem(
      "failed",
      "tax_rate_missing",
      `Xero has no active sales tax rate of ${formatRate(rate)}. Add one in Xero under Accounting > Advanced > Tax rates, or name the rate to use for ${formatRate(rate)} under Tax rates in the app's settings, then retry.`,
    );
  }
  throw new Problem(
    "failed",
    "tax_rate_ambiguous",
    `Xero has several sales tax rates of ${formatRate(rate)}: ${matching.map((entry) => entry.name).join(", ")}. Name the one to use for ${formatRate(rate)} under Tax rates in the app's settings, then retry.`,
  );
}

/** What the tax settings come to, for Test connection: the rates that cannot be chosen by themselves */
export function describeTaxes(rates: TaxRate[], settings: Settings): string[] {
  const usable = salesRates(rates);
  const notes: string[] = [];
  for (const row of settings.taxes?.rates || []) {
    const name = (row?.tax_rate || "").trim();
    if (name && !usable.some((entry) => normal(entry.name) === normal(name) || normal(entry.taxType) === normal(name))) {
      notes.push(`Xero has no active sales tax rate named "${name}".`);
    }
  }
  const byRate = new Map<number, TaxRate[]>();
  for (const entry of usable) {
    const key = Math.round(entry.rate * 10000) / 10000;
    byRate.set(key, [...(byRate.get(key) || []), entry]);
  }
  for (const [rate, entries] of [...byRate.entries()].sort((a, b) => a[0] - b[0])) {
    if (entries.length > 1 && !chosenFor(settings, rate)) {
      notes.push(
        `Orders with ${formatRate(rate)} need a choice under Tax rates, because Xero has several sales tax rates of ${formatRate(rate)}: ${entries.map((entry) => entry.name).join(", ")}.`,
      );
    }
  }
  return notes;
}
