import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { requireProducerAuth } from "../middleware/auth.js";
import { createSubscription, deleteSubscription, listDeliveries, listSubscriptions } from "../db/webhookRepository.js";
import { validateWebhookUrl } from "../services/webhookUrl.js";

const router = Router();
const subscriptionSchema = z.object({ targetUrl: z.string().max(2048), secret: z.string().min(16).max(256).optional() });

router.post("/", requireProducerAuth, async (req, res) => {
  const producer = (req as any).user.id as string;
  if (!StrKey.isValidEd25519PublicKey(producer)) return res.status(400).json({ ok: false, error: "Authenticated producer must be a Stellar address" });
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "targetUrl and an optional secret are required" });
  try {
    const url = await validateWebhookUrl(parsed.data.targetUrl);
    const secret = parsed.data.secret ?? randomBytes(32).toString("hex");
    const subscription = await createSubscription(producer, url.toString(), secret);
    res.status(201).json({ ok: true, data: { ...subscription, secret } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Invalid target URL" });
  }
});

router.get("/", requireProducerAuth, async (req, res) => {
  res.json({ ok: true, data: await listSubscriptions((req as any).user.id) });
});

router.delete("/:id", requireProducerAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "Invalid subscription id" });
  const removed = await deleteSubscription(id, (req as any).user.id);
  if (!removed) return res.status(404).json({ ok: false, error: "Subscription not found" });
  res.status(204).send();
});

router.get("/:id/deliveries", requireProducerAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "Invalid subscription id" });
  res.json({ ok: true, data: await listDeliveries(id, (req as any).user.id) });
});

export { router as webhooksRouter };
