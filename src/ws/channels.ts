import { z } from "zod";
import type { WsClient, WsOutboundMessage } from "./types.js";
import type { ClientManager } from "./clientManager.js";

const CHANNEL_NAME_RE = /^(marketplace|stats|sale:G[A-Z2-7]{55})$/;

const inboundSchema = z.object({
  type: z.enum(["subscribe", "unsubscribe"]),
  channel: z.string().max(100),
});

export function handleMessage(
  client: WsClient,
  raw: string,
  manager: ClientManager,
): WsOutboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "error", data: { message: "Invalid JSON" } };
  }

  const result = inboundSchema.safeParse(parsed);
  if (!result.success) {
    return { type: "error", data: { message: "Invalid message format" } };
  }

  const { type, channel } = result.data;

  if (!CHANNEL_NAME_RE.test(channel)) {
    return { type: "error", data: { message: `Unknown channel: ${channel}` } };
  }

  if (channel.startsWith("sale:")) {
    const targetAddress = channel.slice(5);
    const isOwn = targetAddress === client.userId;
    const isAdmin = client.role === "admin" || client.userId === "platform_api_key";
    if (!isOwn && !isAdmin) {
      return { type: "error", data: { message: "Cannot subscribe to another producer's channel" } };
    }
  }

  if (type === "subscribe") {
    const ok = manager.subscribe(client.id, channel);
    if (!ok) {
      return { type: "error", data: { message: "Subscription limit reached" } };
    }
    return { type: "subscribed", channel };
  }

  manager.unsubscribe(client.id, channel);
  return { type: "unsubscribed", channel };
}
