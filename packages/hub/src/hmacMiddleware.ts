import type { Request, Response, NextFunction } from "express";
import {
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
  verifyHmac,
} from "@wazir/protocol";

export interface RawBodyRequest extends Request {
  rawBody?: string;
}

export function rawBodyCapture(req: RawBodyRequest, _res: Response, _buf: Buffer): void {
  req.rawBody = _buf.toString("utf8");
}

export function createHmacMiddleware(secret: string) {
  return function hmacMiddleware(
    req: RawBodyRequest,
    res: Response,
    next: NextFunction,
  ): void {
    const sig = req.headers[HMAC_HEADER_SIGNATURE];
    const ts = req.headers[HMAC_HEADER_TIMESTAMP];
    const signatureHeader = Array.isArray(sig) ? sig[0] : sig;
    const timestampHeader = Array.isArray(ts) ? ts[0] : ts;
    const rawBody = req.rawBody ?? "";
    const result = verifyHmac(secret, rawBody, signatureHeader, timestampHeader);
    if (!result.ok) {
      res.status(401).json({ error: "unauthorized", reason: result.reason });
      return;
    }
    next();
  };
}
