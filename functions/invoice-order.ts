import { awaitBooking, claimInvoice } from "./lib/process";
import { handleEvent } from "./lib/start";

export const config: SwellConfig = {
  description: "Record the Xero invoice for an order that became paid, and start its run",
  model: {
    events: ["order.paid"],
    conditions: { $settings: { connection: { enabled: true } } },
  },
};

export default async function (req: SwellRequest) {
  return handleEvent(
    req,
    async (ctx) => {
      const claimed = await claimInvoice(ctx, req.data.id as string, "order.paid", false);
      if (!claimed.created) {
        // An invoice created before the order was paid has a payment to book now
        await awaitBooking(ctx, claimed.doc);
      }
      return claimed;
    },
    { rebook: true },
  );
}
