const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const NOT_FOUND = () => new Response("Not Found", { status: 404 });

type TelegramWebhookEnv = Pick<Cloudflare.Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_WEBHOOK_SECRET">;
type TelegramEnqueuer = { enqueueUpdate(update: unknown): Promise<void> };

async function secretsEqual(received: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [receivedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(receivedDigest, expectedDigest);
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    if (total > MAX_WEBHOOK_BODY_BYTES) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function handleTelegramWebhook(
  request: Request,
  env: TelegramWebhookEnv,
  channel: TelegramEnqueuer,
): Promise<Response> {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  const token = env.TELEGRAM_BOT_TOKEN;
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  if (request.method !== "POST" || !token || !expected || !received ||
      !(await secretsEqual(received, expected))) {
    return NOT_FOUND();
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_WEBHOOK_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }
  }

  const bytes = await readBoundedBody(request);
  if (!bytes) return new Response("Payload Too Large", { status: 413 });
  let update: unknown;
  try {
    update = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  await channel.enqueueUpdate(update);
  return new Response("OK", { status: 200 });
}
