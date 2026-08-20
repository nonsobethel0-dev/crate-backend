import jwt from "jsonwebtoken";

export type WsAuthResult =
  | { ok: true; userId: string; role?: string }
  | { ok: false; code: number; message: string };

export function authenticateWsUpgrade(url: URL): WsAuthResult {
  const token = url.searchParams.get("token");
  if (!token) {
    return { ok: false, code: 4001, message: "Missing token parameter" };
  }

  if (process.env.CRATE_API_KEY && token === process.env.CRATE_API_KEY) {
    return { ok: true, userId: "platform_api_key", role: "admin" };
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return { ok: false, code: 4002, message: "Server not configured for auth" };
  }

  try {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    return {
      ok: true,
      userId: (payload.sub ?? payload.id ?? payload.uploader ?? "unknown") as string,
      role: payload.role as string | undefined,
    };
  } catch {
    return { ok: false, code: 4003, message: "Invalid token" };
  }
}
