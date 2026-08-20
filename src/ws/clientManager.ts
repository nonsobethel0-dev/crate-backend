import type { WsClient, WsOutboundMessage } from "./types.js";
import { MAX_SUBSCRIPTIONS_PER_CLIENT, WS_STALE_TIMEOUT_MS } from "./types.js";
import { bigIntReplacer } from "../utils/bigint.js";

export class ClientManager {
  private clients = new Map<string, WsClient>();
  private ipCounts = new Map<string, number>();

  add(client: WsClient): void {
    this.clients.set(client.id, client);
    this.ipCounts.set(client.ip, (this.ipCounts.get(client.ip) ?? 0) + 1);
  }

  remove(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    const count = this.ipCounts.get(client.ip) ?? 0;
    if (count <= 1) {
      this.ipCounts.delete(client.ip);
    } else {
      this.ipCounts.set(client.ip, count - 1);
    }
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.close();
    }
  }

  get(clientId: string): WsClient | undefined {
    return this.clients.get(clientId);
  }

  getByUserId(userId: string): WsClient[] {
    return Array.from(this.clients.values()).filter((c) => c.userId === userId);
  }

  getAll(): WsClient[] {
    return Array.from(this.clients.values());
  }

  subscribe(clientId: string, channel: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    if (client.channels.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) return false;
    client.channels.add(channel);
    return true;
  }

  unsubscribe(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (client) client.channels.delete(channel);
  }

  getChannelSubscribers(channel: string): WsClient[] {
    return Array.from(this.clients.values()).filter((c) => c.channels.has(channel));
  }

  broadcast(channel: string, message: WsOutboundMessage): void {
    const payload = JSON.stringify(message, bigIntReplacer);
    const subscribers = this.getChannelSubscribers(channel);
    for (const client of subscribers) {
      try {
        client.socket.send(payload);
      } catch {
        this.remove(client.id);
      }
    }
  }

  markAlive(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.alive = true;
      client.lastActivityAt = new Date();
    }
  }

  markDead(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.alive = false;
  }

  getStaleClients(): WsClient[] {
    const now = Date.now();
    return Array.from(this.clients.values()).filter(
      (c) => !c.alive || now - c.lastActivityAt.getTime() > WS_STALE_TIMEOUT_MS,
    );
  }

  canAcceptConnection(ip: string): boolean {
    return (this.ipCounts.get(ip) ?? 0) < 5;
  }

  count(): number {
    return this.clients.size;
  }
}
