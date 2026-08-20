import type { WebSocket } from "ws";

export interface WsClient {
  id: string;
  userId: string;
  role?: string;
  ip: string;
  socket: WebSocket;
  channels: Set<string>;
  alive: boolean;
  connectedAt: Date;
  lastActivityAt: Date;
}

export interface WsInboundMessage {
  type: "subscribe" | "unsubscribe";
  channel: string;
}

export type WsOutboundMessage =
  | { type: "connected"; clientId: string }
  | { type: "sale"; channel: string; data: Record<string, unknown> }
  | { type: "upload"; channel: string; data: Record<string, unknown> }
  | { type: "stats"; channel: string; data: Record<string, unknown> }
  | { type: "error"; data: { message: string } }
  | { type: "subscribed"; channel: string }
  | { type: "unsubscribed"; channel: string };

export interface WsNotification {
  type: "sale" | "upload" | "stats";
  channel: string;
  data: Record<string, unknown>;
}

export const MAX_SUBSCRIPTIONS_PER_CLIENT = 10;
export const MAX_CONNECTIONS_PER_IP = 5;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const WS_STALE_TIMEOUT_MS = 60_000;
