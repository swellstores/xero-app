import { claimCreditNote } from "./lib/process";
import { handleEvent } from "./lib/start";

export const config: SwellConfig = {
  description: "Record the Xero credit note for a refunded payment, and start its run",
  model: {
    events: ["payment.refund.succeeded"],
    conditions: { $settings: { connection: { enabled: true } } },
  },
};

export default async function (req: SwellRequest) {
  return handleEvent(req, (ctx) => claimCreditNote(ctx, req.data, "payment.refund.succeeded"));
}
