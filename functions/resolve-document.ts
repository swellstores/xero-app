import { settleAlerts } from "./lib/alerts";
import { isRecordId } from "./lib/documents";
import type { DocumentRecord } from "./lib/documents";

export const config: SwellConfig = {
  description: "Mark a document that needs attention as handled outside the app",
  action: true,
};

export default async function (req: SwellRequest) {
  const id = req.data.$action?.record_id;
  if (!isRecordId(id)) {
    throw new SwellError("Unknown document", { status: 400 });
  }
  const doc = (await req.swell.get(`/documents/${id}`)) as DocumentRecord;
  if (!doc?.id) {
    throw new SwellError("The document record no longer exists", { status: 404 });
  }
  if (doc.xero_id) {
    if (doc.status === "created") {
      throw new SwellError("This document exists in Xero. There is nothing to resolve.", { status: 409 });
    }
    // The document is in Xero and stays as it is. Only finishing it is given up
    await req.swell.put(`/documents/${doc.id}`, { status: "created", problem: null, problem_code: null, locked_until: null, date_pending: null });
    await settleAlerts(req.swell);
    return { message: "Marked as resolved. The document stays in Xero as it is." };
  }

  const number = typeof req.data.number === "string" ? req.data.number.trim().slice(0, 50) : "";
  await req.swell.put(`/documents/${doc.id}`, {
    status: "resolved",
    locked_until: null,
    date_submitted: null,
    date_pending: null,
    ...(number ? { number, name: number } : {}),
  });
  await settleAlerts(req.swell);
  return { message: "Marked as resolved. The app will not create this document." };
}
