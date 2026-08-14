import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Cloudflare Access settings required to verify an assertion. */
export type CfAccessEnv = Readonly<{
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ISS?: string;
}>;

/** Complete Cloudflare Access identity context derived from a verified assertion and trusted config. */
export type VerifiedCfAccessIdentity = Readonly<{
  subject: string;
  email: string;
  expiresAt: Date;
  issuer: string;
  audience: string;
}>;

type AccessTokenVerifier = (token: string, env: CfAccessEnv) => Promise<JWTPayload>;

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyToken(token: string, env: CfAccessEnv): Promise<JWTPayload> {
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_ISS) {
    throw new Error("Cloudflare Access issuer and audience must both be configured.");
  }
  let jwks = remoteJwkSets.get(env.CF_ACCESS_ISS);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.CF_ACCESS_ISS}/cdn-cgi/access/certs`));
    remoteJwkSets.set(env.CF_ACCESS_ISS, jwks);
  }
  return (await jwtVerify(token, jwks, {
    issuer: env.CF_ACCESS_ISS,
    audience: env.CF_ACCESS_AUD,
  })).payload;
}

/** Returns verified Cloudflare Access claims, or null when the assertion cannot be trusted. */
export async function verifyCfAccessJwt(
    request: Request,
    env: CfAccessEnv,
    verifier: AccessTokenVerifier = verifyToken): Promise<JWTPayload | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    return await verifier(token, env);
  } catch {
    return null;
  }
}

/**
 * Builds a complete Access identity only from verified claims and the trusted verification config.
 *
 * The optional clock is used by deterministic tests; production callers use the current time.
 */
export function verifiedCfAccessIdentity(
    payload: JWTPayload,
    env: CfAccessEnv,
    now = Date.now()): VerifiedCfAccessIdentity | null {
  const expiresAtSeconds = payload.exp;
  if (typeof env.CF_ACCESS_ISS !== "string" || env.CF_ACCESS_ISS.trim().length === 0 ||
      typeof env.CF_ACCESS_AUD !== "string" || env.CF_ACCESS_AUD.trim().length === 0 ||
      typeof payload.sub !== "string" || payload.sub.trim().length === 0 ||
      typeof payload.email !== "string" || payload.email.trim().length === 0 ||
      typeof expiresAtSeconds !== "number" ||
      !Number.isFinite(expiresAtSeconds) || !Number.isInteger(expiresAtSeconds)) {
    return null;
  }

  const expiresAtMilliseconds = expiresAtSeconds * 1_000;
  if (!Number.isFinite(expiresAtMilliseconds) || expiresAtMilliseconds <= now) return null;
  return {
    subject: payload.sub,
    email: payload.email,
    expiresAt: new Date(expiresAtMilliseconds),
    issuer: env.CF_ACCESS_ISS,
    audience: env.CF_ACCESS_AUD,
  };
}

/** Returns the non-empty verified Access email claim, without changing its representation. */
export function verifiedCfAccessEmail(payload: JWTPayload): string | null {
  if (typeof payload.email !== "string" || payload.email.trim().length === 0) return null;
  return payload.email;
}

/** Returns a privacy-preserving limiter key derived only from verified Access claims. */
export async function accessRateLimitKey(payload: JWTPayload): Promise<string | null> {
  if (payload.sub) return `access-sub:${payload.sub}`;
  if (typeof payload.email !== "string" || payload.email.length === 0) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.email));
  return `access-email:${new Uint8Array(digest).toHex()}`;
}
