import { findByKey, invoiceKey } from "./lib/documents";
import { awaitBooking } from "./lib/process";
import { invoicedUnpaid } from "./lib/settings";
import { handleEvent } from "./lib/start";

export const config: SwellConfig = {
  description: "Record a payment on the Xero invoice of an order invoiced before it was paid, and start its run",
  model: {
    events: ["payment.succeeded"],
    conditions: { $settings: { connection: { enabled: true } } },
  },
};

/**
 * A payment that leaves the order part paid sends no order.paid. For an order whose payment
 * method the settings invoice before it is paid, each payment is recorded as it arrives
 */
export default async function (req: SwellRequest) {
  return handleEvent(
    req,
    async (ctx) => {
      const orderId = req.data.order_id as string | undefined;
      if (!orderId) {
        return undefined;
      }
      const [doc, order] = await Promise.all([
        findByKey(ctx.swell, invoiceKey(orderId)),
        ctx.swell.get(`/orders/${orderId}`, { fields: "billing.method" }) as Promise<{ billing?: { method?: string } }>,
      ]);
      if (!doc || !invoicedUnpaid(ctx.settings, order)) {
        return undefined;
      }
      await awaitBooking(ctx, doc);
      return { doc };
    },
    { rebook: true },
  );
}
