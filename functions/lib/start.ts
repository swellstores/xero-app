/**
 * Shared path of the two event functions. One document is too much work for a function, so
 * an event only makes sure the document's record exists and starts a workflow run for it.
 *
 * When the run cannot be started, the delivery fails and Swell delivers the event again.
 * The record is there by then, so nothing is lost either way: a record whose run never
 * came, or died, is picked up by the sweep (functions/sweep.ts).
 */

import type { DocumentRecord } from "./documents";
import { needsWork } from "./process";
import type { Context } from "./process";
import type { Settings } from "./settings";

export const WORKFLOW = "process-documents";

export async function handleEvent(
  req: SwellRequest,
  claim: (ctx: Context) => Promise<{ doc: DocumentRecord } | undefined>,
  options: { rebook?: boolean } = {},
): Promise<Record<string, unknown>> {
  // Swell only calls the function while the app is switched on, but the merchant
  // may have switched it off since the event was recorded
  const settings = ((await req.swell.settings()) || {}) as Settings;
  if (settings.connection?.enabled !== true) {
    return { skipped: "The app is switched off" };
  }

  const ctx: Context = { swell: req.swell, settings, rebook: options.rebook };
  const claimed = await claim(ctx);
  if (!claimed) {
    return { skipped: "Nothing to do for this record" };
  }
  if (!needsWork(ctx, claimed.doc)) {
    return { skipped: "The document is complete", document: claimed.doc.id };
  }
  const run = (await req.swell.workflows.create(WORKFLOW, {
    document_id: claimed.doc.id,
    ...(options.rebook ? { rebook: true } : {}),
  })) as { id?: string };
  return { started: run?.id, document: claimed.doc.id };
}
