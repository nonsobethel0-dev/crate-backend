import dns from "node:dns/promises";
import net from "node:net";

function privateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:0" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

export async function validateWebhookUrl(value: string): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("targetUrl must be a valid URL"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname.includes("\\")) {
    throw new Error("targetUrl must be an http(s) URL without credentials");
  }
  if (url.hostname === "localhost" || privateIp(url.hostname)) throw new Error("targetUrl must not target a private network");
  const addresses = net.isIP(url.hostname) ? [url.hostname] : (await dns.lookup(url.hostname, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(privateIp)) throw new Error("targetUrl must not resolve to a private network");
  return url;
}
