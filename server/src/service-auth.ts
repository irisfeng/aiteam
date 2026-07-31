import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ServiceRequest extends Request {
  serviceClaims?: {
    organizationId: string;
    scopes: string[];
    keyId: string | null;
  };
}

type ServiceJwtConfig =
  | { mode: "legacy"; secret: string }
  | { mode: "keyring"; keys: Map<string, string> };

function loadServiceJwtConfig(): ServiceJwtConfig | null {
  const encodedKeys = process.env.AITEAM_SERVICE_JWT_KEYS?.trim();
  if (encodedKeys) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedKeys);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const entries = Object.entries(parsed);
    if (entries.length === 0 || entries.length > 8) return null;
    const keys = new Map<string, string>();
    for (const [keyId, secret] of entries) {
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
        typeof secret !== "string" ||
        Buffer.byteLength(secret) < 32
      ) {
        return null;
      }
      keys.set(keyId, secret);
    }
    return { mode: "keyring", keys };
  }

  const secret = process.env.AITEAM_SERVICE_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) return null;
  return { mode: "legacy", secret };
}

export function requireServiceJwt(
  req: ServiceRequest,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      error: {
        code: "SERVICE_AUTH_REQUIRED",
        message: "A valid service bearer token is required",
      },
    });
    return;
  }

  const config = loadServiceJwtConfig();
  if (!config) {
    res.status(503).json({
      error: {
        code: "SERVICE_AUTH_NOT_CONFIGURED",
        message: "Mission service authentication is not configured",
      },
    });
    return;
  }

  try {
    const token = authorization.slice("Bearer ".length).trim();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token shape");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString("utf8"),
    ) as { alg?: unknown; typ?: unknown; kid?: unknown };
    if (header.alg !== "HS256" || header.typ !== "JWT") {
      throw new Error("unsupported token header");
    }
    const keyId =
      typeof header.kid === "string" &&
      /^[A-Za-z0-9._-]{1,64}$/.test(header.kid)
        ? header.kid
        : null;
    const secret =
      config.mode === "keyring"
        ? keyId
          ? config.keys.get(keyId)
          : undefined
        : header.kid === undefined
          ? config.secret
          : undefined;
    if (!secret) throw new Error("unknown service key");

    const expected = createHmac("sha256", secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const actual = Buffer.from(encodedSignature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("invalid token signature");
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.iss !== "coworker" ||
      payload.aud !== "aiteam" ||
      payload.sub !== "service:coworker" ||
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      typeof payload.iat !== "number" ||
      payload.iat > now + 30 ||
      typeof payload.organization_id !== "string" ||
      payload.organization_id.length === 0 ||
      !Array.isArray(payload.scope) ||
      !payload.scope.every((value) => typeof value === "string")
    ) {
      throw new Error("invalid token claims");
    }

    req.serviceClaims = {
      organizationId: payload.organization_id,
      scopes: payload.scope,
      keyId,
    };
    next();
  } catch {
    res.status(401).json({
      error: {
        code: "SERVICE_AUTH_INVALID",
        message: "The service bearer token is invalid or expired",
      },
    });
  }
}
