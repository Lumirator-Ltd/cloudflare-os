import {
  createClerkClient,
  verifyToken as verifyClerkToken,
} from "@clerk/backend";

const CLERK_API_URL = "https://api.clerk.com";
const CONFIG_ERROR = "Clerk authentication is not configured correctly.";
const VERIFICATION_ERROR = "Clerk identity could not be verified.";
const MAX_KEY_LENGTH = 16_384;
const MAX_CLAIM_LENGTH = 256;
const MAX_AUDIENCE_LENGTH = 1_024;
const MAX_EMAIL_LENGTH = 320;
const MAX_DATE_SECONDS = 8_640_000_000_000;
const MAX_SESSION_TOKEN_LIFETIME_SECONDS = 300;
const MAX_TOKEN_AGE_SECONDS = 300;

/** Environment values used only by trusted backend Clerk verification. */
export type ClerkAuthEnv = Readonly<{
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_JWT_AUDIENCE?: string;
  CLERK_DEV_AUTHORIZED_PARTIES?: string;
  PUBLIC_BASE_URL?: string;
  DEV?: boolean;
}>;

/** Validated backend-only Clerk credentials, routing, and claim constraints. */
export type ClerkVerificationConfig = Readonly<{
  publishableKey: string;
  secretKey: string;
  jwtKey?: string;
  audience?: string;
  issuer: string;
  authorizedParties: string[];
}>;

/** The minimal stable identity accepted from a verified Clerk session. */
export type VerifiedClerkIdentity = Readonly<{
  subject: string;
  email: string;
  expiresAt: Date;
}>;

type ClerkTokenOptions = Readonly<{
  apiUrl: typeof CLERK_API_URL;
  authorizedParties: string[];
  secretKey: string;
  audience?: string;
  jwtKey?: string;
}>;

type ClerkSessionProfile = Readonly<{
  id: unknown;
  userId: unknown;
  status: unknown;
}>;

type ClerkUserProfile = Readonly<{
  id: unknown;
  primaryEmailAddress: null | Readonly<{
    emailAddress: unknown;
    verification: null | Readonly<{ status: unknown }>;
  }>;
}>;

type ClerkClientOptions = Readonly<{
  apiUrl: typeof CLERK_API_URL;
  publishableKey: string;
  secretKey: string;
  telemetry: Readonly<{ disabled: true }>;
}>;

type ClerkBackendClient = Readonly<{
  sessions: Readonly<{
    getSession(sessionId: string): Promise<ClerkSessionProfile>;
  }>;
  users: Readonly<{
    getUser(subject: string): Promise<ClerkUserProfile>;
  }>;
}>;

/** Injectable Clerk SDK boundary used to keep unit and cryptographic fixtures offline. */
export type ClerkAuthDependencies = Readonly<{
  verifyToken(token: string, options: ClerkTokenOptions): Promise<unknown>;
  createClient(options: ClerkClientOptions): ClerkBackendClient;
}>;

const defaultDependencies: ClerkAuthDependencies = {
  verifyToken: (token, options) => verifyClerkToken(token, options),
  createClient: options => createClerkClient(options),
};

function configError(): Error {
  return new Error(CONFIG_ERROR);
}

function verificationError(): Error {
  return new Error(VERIFICATION_ERROR);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function requireConfigString(value: string | undefined, maxLength = MAX_KEY_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength ||
      value !== value.trim() || hasControlCharacters(value)) {
    throw configError();
  }
  return value;
}

function requireJwtKey(value: string): string {
  if (value.length === 0 || value.length > MAX_KEY_LENGTH || value !== value.trim() ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(value)) {
    throw configError();
  }
  return value;
}

function decodePublishableKey(value: string): string {
  if (!/^(?:pk_test_|pk_live_)[A-Za-z0-9+/]+={0,2}$/.test(value)) throw configError();
  const encoded = value.slice(value.indexOf("_", 3) + 1);
  if (encoded.length % 4 === 1) throw configError();
  try {
    return atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
  } catch {
    throw configError();
  }
}

/** Derives the sole acceptable Clerk issuer from a configured publishable key. */
export function deriveClerkIssuer(publishableKey: string): string {
  const key = requireConfigString(publishableKey, 2_048);
  const decoded = decodePublishableKey(key);
  if (!decoded.endsWith("$") || decoded.slice(0, -1).includes("$")) throw configError();

  const host = decoded.slice(0, -1);
  if (host.length > 253 || host !== host.toLowerCase()) throw configError();
  const labels = host.split(".");
  if (labels.length < 2 || labels.some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw configError();
  }
  return `https://${host}`;
}

function exactOrigin(value: string, allowHttp: boolean, requireOriginOnly: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError();
  }
  if ((url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) ||
      url.username || url.password || url.origin === "null") {
    throw configError();
  }
  if (requireOriginOnly && value !== url.origin) throw configError();
  return url.origin;
}

/** Validates Clerk configuration and resolves exact issuer, audience, and authorized parties. */
export function resolveClerkVerificationConfig(env: ClerkAuthEnv): ClerkVerificationConfig {
  const publishableKey = requireConfigString(env.CLERK_PUBLISHABLE_KEY, 2_048);
  const secretKey = requireConfigString(env.CLERK_SECRET_KEY);
  // Only Wrangler's typed local flag enables development origins; string-like production vars do not.
  const local = env.DEV === true;
  const publicBaseUrl = requireConfigString(env.PUBLIC_BASE_URL, 2_048);
  const authorizedParties = [exactOrigin(publicBaseUrl, local, false)];

  if (local && env.CLERK_DEV_AUTHORIZED_PARTIES !== undefined) {
    const configured = requireConfigString(env.CLERK_DEV_AUTHORIZED_PARTIES, 8_192).split(",");
    for (const party of configured) {
      const origin = exactOrigin(party, true, true);
      if (!authorizedParties.includes(origin)) authorizedParties.push(origin);
    }
  }

  const audience = env.CLERK_JWT_AUDIENCE === undefined ? undefined :
    requireConfigString(env.CLERK_JWT_AUDIENCE, MAX_AUDIENCE_LENGTH);
  const jwtKey = env.CLERK_JWT_KEY === undefined ? undefined : requireJwtKey(env.CLERK_JWT_KEY);

  return {
    publishableKey,
    secretKey,
    jwtKey,
    audience,
    issuer: deriveClerkIssuer(publishableKey),
    authorizedParties,
  };
}

function isBoundedClaim(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.startsWith(prefix) &&
    value.length > prefix.length && value.length <= MAX_CLAIM_LENGTH &&
    !hasControlCharacters(value);
}

function isIntegerDate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 &&
    value <= MAX_DATE_SECONDS;
}

function hasExpectedAudience(claim: unknown, expected: string): boolean {
  if (typeof claim === "string") return claim.length > 0 && claim === expected;
  return Array.isArray(claim) && claim.length > 0 &&
    claim.every(value => typeof value === "string" && value.length > 0) &&
    claim.includes(expected);
}

function validateSessionClaims(value: unknown, config: ClerkVerificationConfig) {
  if (typeof value !== "object" || value === null) throw verificationError();
  const claims = value as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1_000);

  // This boundary accepts only Clerk's standard active end-user session token shape. Machine tokens
  // have distinct SDK-documented subjects/header types, while actor and agent sessions carry `act`.
  if (claims.iss !== config.issuer ||
      !isBoundedClaim(claims.sub, "user_") ||
      !isBoundedClaim(claims.sid, "sess_") ||
      claims.sts !== "active" ||
      claims.act !== undefined ||
      typeof claims.azp !== "string" || !config.authorizedParties.includes(claims.azp) ||
      !isIntegerDate(claims.iat) || claims.iat > now || now - claims.iat > MAX_TOKEN_AGE_SECONDS ||
      !isIntegerDate(claims.nbf) || claims.nbf > now ||
      !isIntegerDate(claims.exp) || claims.exp <= now || claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_SESSION_TOKEN_LIFETIME_SECONDS ||
      (config.audience !== undefined && !hasExpectedAudience(claims.aud, config.audience))) {
    throw verificationError();
  }
  return {
    subject: claims.sub,
    sessionId: claims.sid,
    expiresAt: new Date(claims.exp * 1_000),
  };
}

function validateBackendSession(
    session: ClerkSessionProfile,
    expectedSessionId: string,
    expectedSubject: string,
) {
  if (session.id !== expectedSessionId || session.userId !== expectedSubject || session.status !== "active") {
    throw verificationError();
  }
}

function verifiedEmail(profile: ClerkUserProfile, expectedSubject: string): string {
  const primary = profile.primaryEmailAddress;
  const email = primary?.emailAddress;
  if (profile.id !== expectedSubject || primary?.verification?.status !== "verified" ||
      typeof email !== "string" || email.length === 0 || email.length > MAX_EMAIL_LENGTH ||
      email !== email.trim() || !email.includes("@") || hasControlCharacters(email)) {
    throw verificationError();
  }
  return email;
}

/** Verifies a Clerk session and resolves its primary verified email through the fixed Backend API. */
export async function verifyClerkIdentity(
    token: string,
    env: ClerkAuthEnv,
    dependencies: ClerkAuthDependencies = defaultDependencies,
): Promise<VerifiedClerkIdentity> {
  const config = resolveClerkVerificationConfig(env);
  let claims: unknown;
  try {
    claims = await dependencies.verifyToken(token, {
      apiUrl: CLERK_API_URL,
      authorizedParties: config.authorizedParties,
      secretKey: config.secretKey,
      ...(config.audience === undefined ? {} : { audience: config.audience }),
      ...(config.jwtKey === undefined ? {} : { jwtKey: config.jwtKey }),
    });
  } catch {
    throw verificationError();
  }

  const { subject, sessionId, expiresAt } = validateSessionClaims(claims, config);
  let session: ClerkSessionProfile;
  let profile: ClerkUserProfile;
  try {
    const client = dependencies.createClient({
      apiUrl: CLERK_API_URL,
      publishableKey: config.publishableKey,
      secretKey: config.secretKey,
      telemetry: { disabled: true },
    });
    [session, profile] = await Promise.all([
      client.sessions.getSession(sessionId),
      client.users.getUser(subject),
    ]);
  } catch {
    throw verificationError();
  }

  validateBackendSession(session, sessionId, subject);
  const email = verifiedEmail(profile, subject);
  if (expiresAt.getTime() <= Date.now()) throw verificationError();
  return { subject, email, expiresAt };
}
