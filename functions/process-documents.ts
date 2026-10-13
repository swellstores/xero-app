import { DRAFT, UNFINISHED, isRecordId, stale } from "./lib/documents";
import type { DocumentRecord } from "./lib/documents";
import { giveUp, invoiceOrder, run, waitedTooLong } from "./lib/process";
import type { Context, Outcome } from "./lib/process";
import type { Settings } from "./lib/settings";
import { STALE_MS } from "./sweep";

export const config: SwellConfig = {
  kind: "workflow",
  description:
    "Create Xero documents: the one an event or a dashboard action asks for, the selected documents or orders, or every document that is not finished",
  action: true,
};

/**
 * The one place where documents are worked on. A run is started
 * - by the event functions, for the document of an order or a refund
 * - by the buttons on a document and on an order
 * - by the bulk actions of the documents and the order list, and by Retry failed documents
 * - by the sweep, for documents that still wait for Xero
 *
 * A step is the unit that is repeated after a failure. Repeating one is safe: every
 * document continues from what its record in the ledger holds.
 */

// Xero takes 60 calls a minute per organisation, and a document is about five
const BATCH = 5;
// A single document is retried for about ten minutes, then left to the sweep
const ONE = { retries: { limit: 5, delay: "20 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;
const MANY = { retries: { limit: 4, delay: "20 seconds", backoff: "exponential" }, timeout: "3 minutes" } as const;

type Target =
  | { kind: "document"; id: string; approve: boolean; rebook: boolean }
  | { kind: "order"; id: string }
  /** The rows selected in the documents list. `approve` approves their drafts */
  | { kind: "documents"; query: Record<string, any>; approve: boolean }
  /** The rows selected in the order list */
  | { kind: "orders"; query: Record<string, any> }
  /** Everything that is not finished */
  | { kind: "unfinished" }
  /** What waits for Xero and has had no attempt for a while */
  | { kind: "stale" };

interface Batch {
  cursor?: string;
  done: boolean;
  /** Xero refuses the connection. Going on would fail every document the same way */
  halted: boolean;
  created: number;
  failed: number;
  skipped: number;
}

function readTarget(data: Record<string, any>, trigger: string | undefined): Target | undefined {
  if (trigger !== "action") {
    if (isRecordId(data.document_id)) {
      return { kind: "document", id: data.document_id, approve: false, rebook: data.rebook === true };
    }
    return data.stale === true ? { kind: "stale" } : undefined;
  }
  const action = data.$action;
  if (action?.source === "bulk" && action.selection?.query) {
    return action.id === "invoice-selected"
      ? { kind: "orders", query: action.selection.query }
      : { kind: "documents", query: action.selection.query, approve: action.id === "approve-selected" };
  }
  if (action?.source === "settings") {
    return { kind: "unfinished" };
  }
  if (isRecordId(action?.record_id)) {
    return action.id === "create-invoice"
      ? { kind: "order", id: action.record_id }
      : { kind: "document", id: action.record_id, approve: action.id === "approve", rebook: false };
  }
  return undefined;
}

async function context(swell: SwellWorkflowAPI, extra: Partial<Context> = {}): Promise<Context> {
  const settings = ((await swell.settings()) || {}) as Settings;
  return { swell, settings, ...extra };
}

async function processOne(swell: SwellWorkflowAPI, target: Extract<Target, { kind: "document" | "order" }>) {
  let outcome: Outcome;
  if (target.kind === "order") {
    // Asked for on an order that has its invoice, it records a payment that came after it
    outcome = await invoiceOrder(await context(swell, { rebook: true }), target.id, "dashboard");
  } else {
    const doc = (await swell.get(`/documents/${target.id}`)) as DocumentRecord;
    if (!doc?.id) {
      return { result: "missing", message: "The document record no longer exists." };
    }
    outcome = await run(await context(swell, { approve: target.approve, rebook: target.rebook }), doc);
  }
  if (outcome.result === "retry" || outcome.result === "busy") {
    // Xero is unreachable or busy, or another run holds the record: fail the step, which
    // waits and repeats it
    throw new Error(outcome.message);
  }
  return { result: outcome.result, number: outcome.doc.number || null, message: outcome.message };
}

async function nextRecords(swell: SwellWorkflowAPI, target: Target, cursor: string | undefined) {
  const selection = target.kind === "documents" || target.kind === "orders" ? target.query : {};
  const conditions = [
    ...(selection.$and || []),
    // Approving reaches the drafts of a selection and nothing else
    ...(target.kind === "documents" && target.approve ? [DRAFT] : []),
    ...(target.kind === "unfinished" ? [UNFINISHED] : []),
    ...(target.kind === "stale" ? stale(new Date(Date.now() - STALE_MS).toISOString()).$and : []),
    ...(cursor ? [{ id: { $gt: cursor } }] : []),
  ];
  const page = (await swell.get(target.kind === "orders" ? "/orders" : "/documents", {
    ...selection,
    // The store refuses an empty $and
    ...(conditions.length > 0 ? { $and: conditions } : {}),
    sort: "id asc",
    limit: BATCH,
  })) as { results?: Record<string, any>[] };
  return page?.results || [];
}

async function processBatch(swell: SwellWorkflowAPI, target: Target, cursor: string | undefined): Promise<Batch> {
  const ctx = await context(swell, { approve: target.kind === "documents" && target.approve, rebook: target.kind === "orders" });
  const batch: Batch = { cursor, done: false, halted: false, created: 0, failed: 0, skipped: 0 };

  const records = await nextRecords(swell, target, cursor);
  for (const record of records) {
    if (target.kind === "stale" && waitedTooLong(ctx, record as DocumentRecord)) {
      await giveUp(ctx, record as DocumentRecord);
      batch.failed += 1;
      batch.cursor = record.id;
      continue;
    }
    let outcome: Outcome;
    try {
      outcome =
        target.kind === "orders"
          ? await invoiceOrder(ctx, record.id, "dashboard")
          : await run(ctx, record as DocumentRecord);
    } catch (err) {
      // A fault of the store or of the app on this one record, which now holds the message.
      // The records after it are not kept waiting for it
      console.error(`Unable to work on ${target.kind === "orders" ? "order" : "document"} ${record.id}`, (err as Error)?.message || err);
      batch.failed += 1;
      batch.cursor = record.id;
      continue;
    }

    if (outcome.result === "retry" && target.kind !== "stale") {
      // Xero is unreachable or busy: fail the step, which waits and repeats the batch.
      // The sweep moves on instead, and comes back in half an hour
      throw new Error(outcome.message);
    }
    if (outcome.result === "failed" && outcome.doc.problem_code === "connection") {
      batch.halted = true;
      batch.failed += 1;
      return batch;
    }
    batch.created += outcome.result === "created" ? 1 : 0;
    batch.failed += outcome.result === "failed" ? 1 : 0;
    batch.skipped += outcome.result === "skipped" ? 1 : 0;
    batch.cursor = record.id;
  }
  batch.done = records.length < BATCH;
  return batch;
}

export default class ProcessDocuments {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const target = readTarget((req.data || {}) as Record<string, any>, req.workflow?.trigger);
    if (!target) {
      return { result: "ignored", message: "The run names nothing to work on." };
    }
    if (target.kind === "document" || target.kind === "order") {
      return step.do("document", ONE, () => processOne(req.swell, target));
    }

    const totals = { created: 0, failed: 0, skipped: 0, halted: false };
    let cursor: string | undefined;
    for (let index = 1; ; index++) {
      const batch = (await step.do(`documents ${index}`, MANY, () => processBatch(req.swell, target, cursor))) as Batch;
      totals.created += batch.created;
      totals.failed += batch.failed;
      totals.skipped += batch.skipped;
      cursor = batch.cursor;
      if (batch.halted) {
        totals.halted = true;
        break;
      }
      if (batch.done) {
        break;
      }
    }
    return totals;
  }
}
