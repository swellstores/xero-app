import { claimInvoice } from "./lib/process";
import { invoicedUnpaid } from "./lib/settings";
import { handleEvent } from "./lib/start";

export const config: SwellConfig = {
  description: "Record the Xero invoice for an unpaid order placed with a payment method the settings name, and start its run",
  model: {
    events: ["order.submitted"],
    conditions: { $settings: { connection: { enabled: true } } },
  },
};

export default async function (req: SwellRequest) {
  return handleEvent(req, async (ctx) => {
    // A paid order is invoiced by order.paid
    if (req.data.paid || !invoicedUnpaid(ctx.settings, req.data)) {
      return undefined;
    }
    return claimInvoice(ctx, req.data.id as string, "order.submitted", false);
  });
}
