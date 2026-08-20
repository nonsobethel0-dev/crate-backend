import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";
import { URL } from "node:url";
import { ClientManager } from "./clientManager.js";
import { authenticateWsUpgrade } from "./auth.js";
import { handleMessage } from "./channels.js";
import type { WsClient, WsOutboundMessage } from "./types.js";
import { WS_HEARTBEAT_INTERVAL_MS } from "./types.js";
import { bigIntReplacer } from "../utils/bigint.js";

let wss: WebSocketServer | null = null;
let manager: ClientManager | null = null;

export function getManager(): ClientManager {
  if (!manager) throw new Error("WebSocket server not initialized");
  return manager;
}

export function getWss(): WebSocketServer | null {
  return wss;
}

export function initWebSocket(server: Server): WebSocketServer {
  manager = new ClientManager();
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const auth = authenticateWsUpgrade(url);

    if (!auth.ok) {
      socket.write(`HTTP/1.1 ${auth.code} ${auth.message}\r\n\r\n`);
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const auth = authenticateWsUpgrade(url);
    if (!auth.ok) {
      ws.close(auth.code, auth.message);
      return;
    }

    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";

    if (!manager!.canAcceptConnection(ip)) {
      ws.close(4004, "Connection limit reached");
      return;
    }

    const client: WsClient = {
      id: crypto.randomUUID(),
      userId: auth.userId,
      role: auth.role,
      ip,
      socket: ws,
      channels: new Set(),
      alive: true,
      connectedAt: new Date(),
      lastActivityAt: new Date(),
    };

    manager!.add(client);

    ws.on("message", (data) => {
      client.lastActivityAt = new Date();
      const raw = data.toString();
      const response = handleMessage(client, raw, manager!);
      if (response) {
        ws.send(JSON.stringify(response, bigIntReplacer));
      }
    });

    ws.on("pong", () => {
      manager!.markAlive(client.id);
    });

    ws.on("close", () => {
      manager!.remove(client.id);
    });

    ws.on("error", (err) => {
      console.error(`[ws] client ${client.id} error`, err.message);
      manager!.remove(client.id);
    });

    const welcome: WsOutboundMessage = { type: "connected", clientId: client.id };
    ws.send(JSON.stringify(welcome, bigIntReplacer));
  });

  // Heartbeat: ping all clients, terminate those that don't respond
  const heartbeatInterval = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    // Also clean up stale clients from the manager
    for (const client of manager!.getStaleClients()) {
      console.log(`[ws] terminating stale client ${client.id}`);
      client.socket.terminate();
      manager!.remove(client.id);
    }
  }, WS_HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeatInterval));

  return wss;
}

export function broadcast(channel: string, message: WsOutboundMessage): void {
  if (!manager) return;
  manager.broadcast(channel, message);
}
