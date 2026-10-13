/**
 * Alerts: a record in the app's `alerts` collection exists while something needs the
 * merchant. Creating one e-mails the store's administrators (see notifications/), which is
 * why it is a record and not a log line. There is at most one per kind, so a problem that
 * hits every order sends one e-mail, not one per order.
 */

import type { Settings, StoreClient } from "./settings";

export type AlertKey =
  /** Xero refuses the connection: nothing can be created until it is fixed */
  | "connection"
  /** At least one document needs attention */
  | "documents";

// The same problem seen again after a quiet day is a new incident and sends a new e-mail
const SAME_INCIDENT_MS = 24 * 60 * 60 * 1000;

async function find(swell: StoreClient, key: AlertKey): Promise<Record<string, any> | undefined> {
  const found = (await swell.get("/alerts", { where: { key }, limit: 1 })) as { results?: Record<string, any>[] };
  return found?.results?.[0];
}

/** Never throws: failing to record a problem must not hide the problem itself */
export async function raiseAlert(swell: StoreClient, key: AlertKey, message: string, subject?: string): Promise<void> {
  try {
    const now = new Date();
    const existing = await find(swell, key);

    if (existing) {
      const lastSeen = new Date(existing.date_last_seen || existing.date_created).getTime();
      if (now.getTime() - lastSeen < SAME_INCIDENT_MS) {
        await swell.put(`/alerts/${existing.id}`, {
          message,
          subject: subject || null,
          count: (existing.count || 1) + 1,
          date_last_seen: now.toISOString(),
        });
        return;
      }
      await swell.delete(`/alerts/${existing.id}`);
    }

    // The id of the settings record is the app's record id, which the dashboard address
    // of the app's pages is built from. The e-mail links there
    const settings = (await swell.settings()) as Settings | null;
    // The e-mail is sent by the event of this record's creation, and a write made in a
    // workflow raises no events unless it asks for them. It also has to name the
    // notification: without the name, the store drops the e-mail of some workflow writes
    await swell.post("/alerts", {
      $events: true,
      $notify: "alert.v2",
      key,
      message,
      subject: subject || null,
      count: 1,
      date_last_seen: now.toISOString(),
      app_id: settings?.id,
    });
  } catch (err) {
    console.error("Unable to record the alert", (err as Error).message);
  }
}

export async function clearAlert(swell: StoreClient, key: AlertKey): Promise<void> {
  try {
    const existing = await find(swell, key);
    if (existing) {
      await swell.delete(`/alerts/${existing.id}`);
    }
  } catch (err) {
    console.error("Unable to clear the alert", (err as Error).message);
  }
}

/**
 * Called after a document was finished or resolved: the connection works, and the
 * documents alert is over once nothing is left that needs attention.
 */
export async function settleAlerts(swell: StoreClient): Promise<void> {
  try {
    const alerts = (await swell.get("/alerts", { limit: 10 })) as { results?: Record<string, any>[] };
    for (const alert of alerts?.results || []) {
      if (alert.key === "documents") {
        const failed = (await swell.get("/documents", { where: { status: "failed" }, limit: 1 })) as { count?: number };
        if ((failed?.count || 0) > 0) {
          continue;
        }
      }
      await swell.delete(`/alerts/${alert.id}`);
    }
  } catch (err) {
    console.error("Unable to settle the alerts", (err as Error).message);
  }
}
