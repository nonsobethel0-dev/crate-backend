import pg from "pg";
import { broadcast } from "./server.js";
import type { WsNotification } from "./types.js";

const CHANNEL = "crate_ws_events";

let listenerClient: pg.Client | null = null;

export async function startEventListener(): Promise<void> {
  listenerClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await listenerClient.connect();
  await listenerClient.query(`LISTEN ${CHANNEL}`);

  listenerClient.on("notification", (msg) => {
    if (!msg.payload) return;
    try {
      const notification: WsNotification = JSON.parse(msg.payload);
      broadcast(notification.channel, {
        type: notification.type,
        channel: notification.channel,
        data: notification.data,
      });
    } catch (err) {
      console.error("[ws:eventBus] failed to parse notification", err);
    }
  });

  listenerClient.on("error", (err) => {
    console.error("[ws:eventBus] listener connection error", err.message);
    setTimeout(() => {
      startEventListener().catch((e) =>
        console.error("[ws:eventBus] reconnect failed", e.message),
      );
    }, 5_000);
  });

  console.log("[ws:eventBus] listening on PostgreSQL channel:", CHANNEL);
}

export async function stopEventListener(): Promise<void> {
  if (listenerClient) {
    await listenerClient.end();
    listenerClient = null;
  }
}

export async function notifyWsClients(
  db: pg.PoolClient,
  notification: WsNotification,
): Promise<void> {
  await db.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(notification)]);
}
