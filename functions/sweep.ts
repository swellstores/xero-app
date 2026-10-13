import { stale } from "./lib/documents";
import { WORKFLOW } from "./lib/start";

export const config: SwellConfig = {
  description: "Every half hour: start a run for documents that are still waiting for Xero",
  cron: { schedule: "*/30 * * * *" },
};

// A run retries a document for some minutes by itself. Only what has had no attempt for
// longer than that is waiting for nobody
export const STALE_MS = 15 * 60 * 1000;

export default async function (req: SwellRequest) {
  const before = new Date(Date.now() - STALE_MS).toISOString();
  const waiting = (await req.swell.get("/documents", { ...stale(before), limit: 1 })) as { count?: number };
  if (!waiting?.count) {
    return { waiting: 0 };
  }
  const run = (await req.swell.workflows.create(WORKFLOW, { stale: true })) as { id?: string };
  return { waiting: waiting.count, started: run?.id };
}
