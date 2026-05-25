import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const HMAC_HEADER_SIGNATURE = "x-wazir-signature";
export const HMAC_HEADER_TIMESTAMP = "x-wazir-timestamp";
export const HMAC_MAX_SKEW_SECONDS = 300;

export function generateHmacSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, rawBody: string, timestamp: number): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.${rawBody}`);
  return `sha256=${mac.digest("hex")}`;
}

export interface HmacVerifyResult {
  ok: boolean;
  reason?: "missing_header" | "bad_timestamp" | "expired" | "bad_signature";
}

export function verifyHmac(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): HmacVerifyResult {
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: "missing_header" };
  }
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  if (Math.abs(nowSeconds - ts) > HMAC_MAX_SKEW_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  const expected = signPayload(secret, rawBody, ts);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
