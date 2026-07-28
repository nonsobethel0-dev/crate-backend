import { pool } from "./client.js";
import type { Pool, PoolClient } from "pg";

export interface WebhookSubscription {
  id: number;
  producer_address: string;
  target_url: string;
  active: boolean;
  created_at: Date;
}

export interface WebhookDelivery {
  id: number;
  subscription_id: number;
  sale_event_id: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: Date;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export async function createSubscription(
  producerAddress: string,
  targetUrl: string,
  secret: string,
  db: Pool = pool,
): Promise<WebhookSubscription> {
  const { rows } = await db.query<WebhookSubscription>(
    `INSERT INTO webhook_subscriptions (producer_address, target_url, secret)
     VALUES ($1, $2, $3)
     ON CONFLICT (producer_address, target_url) DO UPDATE
       SET secret = EXCLUDED.secret, active = TRUE, updated_at = NOW()
     RETURNING id, producer_address, target_url, active, created_at`,
    [producerAddress, targetUrl, secret],
  );
  return rows[0]!;
}

export async function listSubscriptions(producerAddress: string, db: Pool = pool) {
  const { rows } = await db.query<WebhookSubscription>(
    `SELECT id, producer_address, target_url, active, created_at
       FROM webhook_subscriptions WHERE producer_address = $1 ORDER BY created_at DESC`,
    [producerAddress],
  );
  return rows;
}

export async function deleteSubscription(id: number, producerAddress: string, db: Pool = pool): Promise<boolean> {
  const result = await db.query(
    "UPDATE webhook_subscriptions SET active = FALSE, updated_at = NOW() WHERE id = $1 AND producer_address = $2",
    [id, producerAddress],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listDeliveries(subscriptionId: number, producerAddress: string, db: Pool = pool) {
  const { rows } = await db.query<WebhookDelivery>(
    `SELECT d.id, d.subscription_id, d.sale_event_id, d.payload, d.status, d.attempts,
            d.next_attempt_at, d.last_status_code, d.last_error, d.delivered_at, d.created_at
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.subscription_id
      WHERE d.subscription_id = $1 AND s.producer_address = $2
      ORDER BY d.created_at DESC`,
    [subscriptionId, producerAddress],
  );
  return rows;
}

export async function enqueueSaleDelivery(
  saleEventId: string,
  producerAddress: string,
  payload: Record<string, unknown>,
  db: PoolClient,
) {
  await db.query(
    `INSERT INTO webhook_deliveries (subscription_id, sale_event_id, payload)
     SELECT id, $1, $3::jsonb FROM webhook_subscriptions
      WHERE producer_address = $2 AND active = TRUE
     ON CONFLICT (subscription_id, sale_event_id) DO NOTHING`,
    [saleEventId, producerAddress, JSON.stringify(payload)],
  );
}

export async function claimDueDeliveries(db: Pool = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT d.id, d.subscription_id, d.sale_event_id, d.payload, d.attempts,
              s.target_url, s.secret
         FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= NOW() AND s.active = TRUE
        ORDER BY d.next_attempt_at ASC
        FOR UPDATE OF d SKIP LOCKED LIMIT 25`,
    );
    for (const row of rows) {
      await client.query("UPDATE webhook_deliveries SET next_attempt_at = NOW() + INTERVAL '5 minutes' WHERE id = $1", [row.id]);
    }
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function recordDeliveryAttempt(
  id: number,
  ok: boolean,
  statusCode: number | null,
  error: string | null,
  db: Pool = pool,
) {
  await db.query(
    `UPDATE webhook_deliveries
        SET attempts = attempts + 1,
            status = CASE WHEN $2 THEN 'delivered' ELSE CASE WHEN attempts + 1 >= 10 THEN 'failed' ELSE 'pending' END END,
            last_status_code = $3, last_error = $4,
            delivered_at = CASE WHEN $2 THEN NOW() ELSE delivered_at END,
            next_attempt_at = CASE WHEN $2 OR attempts + 1 >= 10 THEN next_attempt_at
              ELSE NOW() + LEAST((POWER(2, attempts + 1) * INTERVAL '30 seconds'), INTERVAL '1 day') END,
            updated_at = NOW()
      WHERE id = $1`,
    [id, ok, statusCode, error],
  );
}
