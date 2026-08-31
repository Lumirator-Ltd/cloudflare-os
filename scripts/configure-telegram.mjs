import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

class TelegramSetupError extends Error {}

async function requestTelegram(fetch, token, method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, body === undefined ? {
      method: "GET",
      redirect: "error",
    } : {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TelegramSetupError(`Telegram ${method} request failed.`);
  }

  if (!response.ok) {
    throw new TelegramSetupError(`Telegram ${method} request failed (HTTP ${response.status}).`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TelegramSetupError(`Telegram ${method} returned an invalid response.`);
  }

  if (payload === null || typeof payload !== "object" || payload.ok !== true) {
    throw new TelegramSetupError(`Telegram ${method} rejected the request.`);
  }
  return payload.result;
}

/**
 * Verifies a Telegram bot, registers its Workshop webhook, and returns deployment metadata.
 * The caller owns secure storage and injection of the returned webhook secret.
 */
export async function configureTelegram({ token, publicBaseUrl, webhookSecret, fetch }) {
  const resolvedWebhookSecret = webhookSecret ?? randomBytes(32).toString("base64url");
  const identity = await requestTelegram(fetch, token, "getMe");
  if (identity === null || typeof identity !== "object" ||
      !Number.isSafeInteger(identity.id) || identity.id <= 0 ||
      typeof identity.username !== "string" || identity.username.trim() === "") {
    throw new TelegramSetupError("Telegram getMe returned an invalid bot identity.");
  }

  const webhookUrl = `${publicBaseUrl.replace(/\/+$/, "")}/api/telegram/webhook`;
  const setResult = await requestTelegram(fetch, token, "setWebhook", {
    url: webhookUrl,
    secret_token: resolvedWebhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  if (setResult !== true) {
    throw new TelegramSetupError("Telegram setWebhook did not confirm registration.");
  }

  const webhookInfo = await requestTelegram(fetch, token, "getWebhookInfo");
  if (webhookInfo === null || typeof webhookInfo !== "object" ||
      webhookInfo.url !== webhookUrl || Object.hasOwn(webhookInfo, "last_error_message")) {
    throw new TelegramSetupError("Telegram webhook verification failed.");
  }

  return {
    botId: identity.id,
    botUsername: identity.username,
    webhookUrl,
    webhookSecret: resolvedWebhookSecret,
  };
}

function requireEnv(env, name) {
  if (typeof env[name] !== "string" || env[name].trim() === "") {
    throw new TelegramSetupError(`${name} is required.`);
  }
  return env[name];
}

/**
 * Runs non-interactive Telegram setup using injected deployment secrets.
 * Returns an exit code and writes only sanitized status messages to the supplied channels.
 */
export async function runConfigureTelegramCli({
  env = process.env,
  fetch = globalThis.fetch,
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
} = {}) {
  try {
    const token = requireEnv(env, "TELEGRAM_BOT_TOKEN");
    const publicBaseUrl = requireEnv(env, "PUBLIC_BASE_URL");
    const webhookSecret = requireEnv(env, "TELEGRAM_WEBHOOK_SECRET");
    const result = await configureTelegram({ token, publicBaseUrl, webhookSecret, fetch });

    stdout(`Verified Telegram bot: @${result.botUsername}\n`);
    stdout(`Verified Telegram webhook: ${result.webhookUrl}\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof TelegramSetupError ? error.message : "Unexpected error.";
    stderr(`Telegram configuration failed: ${reason}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runConfigureTelegramCli();
}
