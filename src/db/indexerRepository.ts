import { pool } from "./client.js";
import { incrementSales } from "./sampleRepository.js";
import type { DecodedEvent } from "../indexer/types.js";
import type { Pool } from "pg";
import { enqueueSaleDelivery } from "./webhookRepository.js";

// Every function here defaults to the shared pool but accepts an injectable
// Pool — lets tests run this exact code against a pg-mem instance instead of
// a hand-reimplemented approximation of its SQL.

export async function getCursor(contractId: string, db: Pool = pool): Promise<number | null> {
  const result = await db.query<{ last_ledger: number }>(
    "SELECT last_ledger FROM indexer_cursor WHERE contract_id = $1",
    [contractId],
  );
  return result.rows[0]?.last_ledger ?? null;
}

/**
 * Sets the cursor only if one doesn't already exist — used once, to seed the
 * backfill start point on first run. Safe to call more than once (e.g. two
 * worker instances racing on startup): whichever insert wins is authoritative,
 * the other is a no-op, and the caller should re-read via getCursor after.
 */
export async function initCursor(contractId: string, lastLedger: number, db: Pool = pool): Promise<void> {
  await db.query(
    `INSERT INTO indexer_cursor (contract_id, last_ledger)
     VALUES ($1, $2)
     ON CONFLICT (contract_id) DO NOTHING`,
    [contractId, lastLedger],
  );
}

export interface ApplyResult {
  applied: number;
  skipped: number;
}

/**
 * Applies a batch of already-decoded events and advances the cursor to
 * newLastLedger, all in one transaction. Each event insert is
 * ON CONFLICT (ledger, tx_hash, event_index) DO NOTHING RETURNING id, and the
 * side effects (samples.total_sales, platform_stats) only fire when a row
 * actually comes back. That's what makes replaying an already-applied range
 * safe — whether from a single worker's restart, or two workers processing
 * an overlapping range concurrently: the losing insert's RETURNING is empty,
 * so it can't double the side effects even though it started from the same
 * "not applied yet" state as the winner. The cursor only advances if the
 * whole batch commits, so a crash partway through never leaves it ahead of
 * what's actually applied.
 */
export async function applyEventBatchAndAdvanceCursor(
  contractId: string,
  events: DecodedEvent[],
  newLastLedger: number,
  db: Pool = pool,
): Promise<ApplyResult> {
  const client = await db.connect();
  let applied = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const event of events) {
      const payload =
        event.eventType === "uploaded"
          ? { uploader: event.uploader }
          : { buyer: event.buyer, price: event.price.toString() };

      const inserted = await client.query(
        `INSERT INTO contract_events
           (contract_id, ledger, tx_hash, event_index, event_type, sample_id, payload, ledger_closed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (ledger, tx_hash, event_index) DO NOTHING
         RETURNING id`,
        [
          event.contractId,
          event.ledger,
          event.txHash,
          event.eventIndex,
          event.eventType,
          event.sampleId,
          JSON.stringify(payload),
          event.ledgerClosedAt,
        ],
      );

      if ((inserted.rowCount ?? 0) === 0) {
        // Already applied — by this worker or a concurrent one. Must not
        // re-apply side effects.
        skipped++;
        continue;
      }
      applied++;

      if (event.eventType === "licensed") {
        const rowsUpdated = await incrementSales(event.sampleId, client);
        if (rowsUpdated === 0) {
          console.warn(
            `[indexerRepository] licensed event for sample_id ${event.sampleId} has no matching row in samples ` +
              `(metadata never POSTed to /api/samples/metadata) — total_sales not incremented`,
          );
        }
        await client.query(
          `INSERT INTO platform_stats (contract_id, total_volume)
           VALUES ($1, $2)
           ON CONFLICT (contract_id) DO UPDATE SET
             total_volume = platform_stats.total_volume + EXCLUDED.total_volume,
             updated_at = NOW()`,
          [contractId, event.price],
        );
        // Webhook delivery is an optional migration for deployments upgrading
        // from the indexer schema. Keep sale accounting usable while that
        // migration is being applied.
        try {
          const producer = await client.query<{ uploader: string }>("SELECT uploader FROM samples WHERE id = $1", [event.sampleId]);
          if (producer.rows[0]) {
            await enqueueSaleDelivery(`${event.ledger}:${event.txHash}:${event.eventIndex}`, producer.rows[0].uploader, {
              event: "sale",
              eventId: `${event.ledger}:${event.txHash}:${event.eventIndex}`,
              sampleId: event.sampleId.toString(),
              buyer: event.buyer,
              price: event.price.toString(),
              ledger: event.ledger,
              occurredAt: event.ledgerClosedAt,
            }, client);
          }
        } catch (err) {
          console.warn("[indexerRepository] webhook migration unavailable; sale delivery was not enqueued", err);
        }
      } else {
        // Mirrors the contract's own Producer(Address) flag: only count a
        // producer toward total_producers the first time we see them upload.
        // Same RETURNING-gated check as above, for the same concurrency reason.
        const producerInserted = await client.query(
          "INSERT INTO known_producers (address) VALUES ($1) ON CONFLICT DO NOTHING RETURNING address",
          [event.uploader],
        );
        const isNewProducer = (producerInserted.rowCount ?? 0) > 0;

        await client.query(
          `INSERT INTO platform_stats (contract_id, total_samples, total_producers)
           VALUES ($1, 1, $2)
           ON CONFLICT (contract_id) DO UPDATE SET
             total_samples = platform_stats.total_samples + 1,
             total_producers = platform_stats.total_producers + EXCLUDED.total_producers,
             updated_at = NOW()`,
          [contractId, isNewProducer ? 1 : 0],
        );
      }
    }

    await client.query(
      `INSERT INTO indexer_cursor (contract_id, last_ledger)
       VALUES ($1, $2)
       ON CONFLICT (contract_id) DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = NOW()`,
      [contractId, newLastLedger],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { applied, skipped };
}

export interface PlatformStats {
  totalSamples: number;
  totalVolume: bigint;
  totalProducers: number;
}

export async function getPlatformStats(contractId: string, db: Pool = pool): Promise<PlatformStats> {
  const result = await db.query<{
    total_samples: number;
    total_volume: bigint;
    total_producers: number;
  }>(
    "SELECT total_samples, total_volume, total_producers FROM platform_stats WHERE contract_id = $1",
    [contractId],
  );

  const row = result.rows[0];
  if (!row) {
    return { totalSamples: 0, totalVolume: 0n, totalProducers: 0 };
  }
  return {
    totalSamples: row.total_samples,
    totalVolume: row.total_volume,
    totalProducers: row.total_producers,
  };
}
