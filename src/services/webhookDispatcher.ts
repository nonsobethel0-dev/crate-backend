import crypto from "node:crypto";
import { claimDueDeliveries, recordDeliveryAttempt } from "../db/webhookRepository.js";

export async function dispatchDueWebhooks(): Promise<void> {
  const deliveries = await claimDueDeliveries();
  await Promise.all(deliveries.map(async (delivery) => {
    const body = JSON.stringify(delivery.payload);
    const signature = crypto.createHmac("sha256", delivery.secret).update(body).digest("hex");
    try {
      const response = await fetch(delivery.target_url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-crate-event": "sale", "x-crate-signature": `sha256=${signature}`, "x-crate-delivery-id": String(delivery.id) },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      await recordDeliveryAttempt(delivery.id, response.ok, response.status, response.ok ? null : `HTTP ${response.status}`);
    } catch (err) {
      await recordDeliveryAttempt(delivery.id, false, null, err instanceof Error ? err.message : "Delivery failed");
    }
  }));
}
