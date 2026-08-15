import type { UserDurableObject } from "./user.js";

const MAX_LOGOUT_BODY_BYTES = 256;
const INTERNAL_USER_ID_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

class LogoutRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(message, { status, headers });
}

async function readBoundedBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new LogoutRequestError(400, "Invalid request body.");
    }
    if (Number(contentLength) > MAX_LOGOUT_BODY_BYTES) {
      throw new LogoutRequestError(413, "Request body too large.");
    }
  }

  if (!request.body) throw new LogoutRequestError(400, "Invalid request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LOGOUT_BODY_BYTES) {
        await reader.cancel();
        throw new LogoutRequestError(413, "Request body too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new LogoutRequestError(400, "Invalid request body.");
  }
}

function parseBearer(body: string): { internalUserId: string; secret: string } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new LogoutRequestError(400, "Invalid request body.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !("token" in value) ||
      typeof value.token !== "string") {
    throw new LogoutRequestError(400, "Invalid request body.");
  }

  const separator = value.token.indexOf(":");
  if (separator < 0 || separator !== value.token.lastIndexOf(":")) {
    throw new LogoutRequestError(400, "Invalid session token format.");
  }
  const internalUserId = value.token.slice(0, separator);
  const secret = value.token.slice(separator + 1);
  if (!INTERNAL_USER_ID_PATTERN.test(internalUserId) ||
      !SESSION_SECRET_PATTERN.test(secret)) {
    throw new LogoutRequestError(400, "Invalid session token format.");
  }
  try {
    const decoded = Uint8Array.fromBase64(secret);
    if (decoded.byteLength !== 32 || decoded.toBase64() !== secret) {
      throw new LogoutRequestError(400, "Invalid session token format.");
    }
  } catch (error) {
    if (error instanceof LogoutRequestError) throw error;
    throw new LogoutRequestError(400, "Invalid session token format.");
  }
  return { internalUserId, secret };
}

/**
 * Handles same-origin local Gatekeeper bearer revocation independently of WebSocket RPC.
 *
 * A syntactically valid bearer is idempotent: missing and already-revoked records return 204 just
 * like a live record, without revealing token existence. The response is sent only after durable
 * deletion and every live subscriber invalidation have completed.
 */
export async function handleGatekeeperSessionLogoutRequest(
    request: Request,
    users: DurableObjectNamespace<UserDurableObject>,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "Method not allowed.", { Allow: "POST" });
  }

  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin) {
    return errorResponse(403, "Same-origin request required.");
  }
  if (request.headers.get("Content-Type") !== "application/json") {
    return errorResponse(415, "Content-Type must be application/json.");
  }

  try {
    const { internalUserId, secret } = parseBearer(await readBoundedBody(request));
    await users.getByName(internalUserId).revokeGatekeeperSession(secret);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof LogoutRequestError) {
      return errorResponse(error.status, error.message);
    }
    return errorResponse(500, "Gatekeeper session logout failed.");
  }
}
