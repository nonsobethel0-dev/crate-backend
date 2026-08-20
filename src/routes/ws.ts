import { Router } from "express";
import { getManager } from "../ws/server.js";

const router = Router();

router.get("/stats", (_req, res) => {
  const manager = getManager();
  const clients = manager.getAll();

  const channelCounts: Record<string, number> = {};
  for (const client of clients) {
    for (const ch of client.channels) {
      channelCounts[ch] = (channelCounts[ch] ?? 0) + 1;
    }
  }

  res.json({
    ok: true,
    data: {
      totalConnections: clients.length,
      uniqueUsers: new Set(clients.map((c) => c.userId)).size,
      channels: channelCounts,
      uptime: process.uptime(),
    },
  });
});

export { router as wsRouter };
