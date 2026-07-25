import { getLatestLedger, fetchEventsInRange } from "./sorobanEvents.js";
import { decodeEvents } from "./eventDecoder.js";
import {
  getCursor,
  initCursor,
  applyEventBatchAndAdvanceCursor,
} from "../db/indexerRepository.js";
import { dispatchDueWebhooks } from "../services/webhookDispatcher.js";

export interface IndexerConfig {
  contractId: string;
  pollIntervalMs: number;
  backfillLedgers: number;
  startLedger?: number;
  ledgersPerWindow: number;
  eventsPageSize: number;
}

export function loadConfigFromEnv(): IndexerConfig {
  const contractId = process.env.CONTRACT_ID;
  if (!contractId) {
    throw new Error("CONTRACT_ID is required to run the indexer");
  }

  return {
    contractId,
    pollIntervalMs: Number(process.env.INDEXER_POLL_INTERVAL_MS) || 30_000,
    // ~7 days at 5s/ledger — a reasonable default backfill depth on first
    // run; most RPC providers don't retain getEvents history much further
    // back than this anyway. Override with INDEXER_START_LEDGER for a
    // specific starting point instead.
    backfillLedgers: Number(process.env.INDEXER_BACKFILL_LEDGERS) || 120_960,
    startLedger: process.env.INDEXER_START_LEDGER
      ? Number(process.env.INDEXER_START_LEDGER)
      : undefined,
    ledgersPerWindow: Number(process.env.INDEXER_LEDGERS_PER_WINDOW) || 10_000,
    eventsPageSize: Number(process.env.INDEXER_EVENTS_PAGE_SIZE) || 200,
  };
}

/**
 * Returns the last processed ledger, seeding the cursor from either
 * INDEXER_START_LEDGER or (latest - backfillLedgers) if this is the first
 * run for this contract. Safe if called concurrently by more than one
 * worker instance — initCursor's insert is a no-op for whichever loses the
 * race, and we re-read afterward so both instances agree on the same value.
 */
async function ensureCursor(config: IndexerConfig): Promise<number> {
  const existing = await getCursor(config.contractId);
  if (existing !== null) return existing;

  const latest = await getLatestLedger();
  const start = config.startLedger ?? Math.max(1, latest - config.backfillLedgers);

  // last_ledger means "processed through this ledger", so seed one below
  // the first ledger we actually want to scan.
  await initCursor(config.contractId, start - 1);
  return (await getCursor(config.contractId)) ?? start - 1;
}

/**
 * Runs one backfill/catch-up pass: from the persisted cursor up to whatever
 * the chain tip is at the moment this starts, in bounded ledgers-per-window
 * chunks so a single run doesn't hold one giant transaction open or request
 * an unbounded event range from the RPC.
 */
export async function indexOnce(config: IndexerConfig): Promise<void> {
  const latest = await getLatestLedger();
  let lastLedger = await ensureCursor(config);

  while (lastLedger < latest) {
    const from = lastLedger + 1;
    const to = Math.min(from + config.ledgersPerWindow - 1, latest);

    const rawEvents = await fetchEventsInRange(
      config.contractId,
      from,
      to,
      config.eventsPageSize,
    );
    const decoded = decodeEvents(rawEvents);

    const { applied, skipped } = await applyEventBatchAndAdvanceCursor(
      config.contractId,
      decoded,
      to,
    );

    console.log(
      `[indexer] ledgers ${from}-${to}: ${rawEvents.length} events fetched, ${applied} applied, ${skipped} already seen`,
    );

    lastLedger = to;
  }
  await dispatchDueWebhooks();
}

/**
 * Runs indexOnce on a fixed interval until the abort signal fires. A failed
 * cycle (RPC hiccup, DB blip) is logged and retried on the next interval
 * rather than crashing the process — the cursor never advances past what
 * actually committed, so there's nothing to "recover", just pick up again.
 */
export async function runForever(
  config: IndexerConfig,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    try {
      await indexOnce(config);
    } catch (err) {
      console.error("[indexer] poll cycle failed, will retry next interval", err);
    }
    await sleep(config.pollIntervalMs, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
