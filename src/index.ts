import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { corsMiddleware } from "./middleware/cors.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import { samplesRouter } from "./routes/samples.js";
import { ipfsRouter } from "./routes/ipfs.js";
import { analyticsRouter } from "./routes/analytics.js";
import { royaltiesRouter } from "./routes/royalties.js";
import { moderationRouter } from "./routes/moderation.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { pool, checkDbConnection } from "./db/client.js";

const app = express();
const PORT = process.env.PORT ?? 3001;

const limiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });

app.use(helmet());
app.use(limiter);
app.use(morgan("combined"));
app.use(corsMiddleware);
app.set("trust proxy", 1);
// pg parses BIGINT columns (chain_id, lease_price, ...) into native BigInt,
// which JSON.stringify can't serialize on its own — every res.json() call
// on a row with those columns would 500 without this.
app.set("json replacer", (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value,
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await checkDbConnection();
    res.json({ status: "ok", db: "ok", ts: Date.now() });
  } catch {
    res.status(503).json({ status: "degraded", db: "unreachable", ts: Date.now() });
  }
});

app.use("/api/samples", samplesRouter);
app.use("/api/samples", royaltiesRouter);
app.use("/api/ipfs", ipfsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/moderation", moderationRouter);
app.use("/api/webhooks", webhooksRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error]", err instanceof Error ? err.stack ?? err.message : err);
  res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
});

const server = app.listen(PORT, () => console.log(`Crate API running on :${PORT}`));
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error("[fatal] server error", err.message);
  process.exit(1);
});

function gracefulShutdown(signal: string) {
  console.log(`[shutdown] ${signal} received, draining pool...`);
  pool.end().then(() => {
    console.log("[shutdown] pool closed.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
