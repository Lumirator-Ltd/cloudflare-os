import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
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
      typeof identity.username !== "string" ||
      !/^[A-Za-z0-9_]{5,32}$/.test(identity.username)) {
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

async function defaultCommandRunner(command, args, { stdin } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve(output);
      else reject(new Error("Deployment command failed."));
    });
    child.stdin.end(stdin);
  });
}

function wranglerArgs(action, name, config) {
  return ["exec", "wrangler", "secret", action, name, "--config", config];
}

async function listWorkerSecretNames(commandRunner, config) {
  try {
    const output = await commandRunner("pnpm", [
      "exec", "wrangler", "secret", "list", "--format", "json", "--config", config,
    ], {});
    const secrets = JSON.parse(output);
    if (!Array.isArray(secrets) || secrets.some(secret =>
      secret === null || typeof secret !== "object" || typeof secret.name !== "string")) {
      throw new Error("Invalid secret list.");
    }
    return new Set(secrets.map(secret => secret.name));
  } catch {
    throw new TelegramSetupError("Worker secret inspection failed.");
  }
}

async function putWorkerSecret(commandRunner, config, name, value) {
  try {
    await commandRunner("pnpm", wranglerArgs("put", name, config), { stdin: `${value}\n` });
  } catch {
    throw new TelegramSetupError("Worker secret installation failed.");
  }
}

async function deleteWorkerSecret(commandRunner, config, name) {
  try {
    await commandRunner("pnpm", wranglerArgs("delete", name, config), { stdin: "y\n" });
  } catch {
    throw new TelegramSetupError("Worker secret removal failed.");
  }
}

async function deleteWebhook(fetch, token) {
  const result = await requestTelegram(fetch, token, "deleteWebhook", {
    drop_pending_updates: false,
  });
  if (result !== true) throw new TelegramSetupError("Telegram deleteWebhook did not confirm removal.");
}

async function rollbackInstalledSecrets(commandRunner, config, installed) {
  for (const name of installed.toReversed()) {
    try {
      await deleteWorkerSecret(commandRunner, config, name);
    } catch {
      // Rollback is best effort; the original sanitized failure remains authoritative.
    }
  }
}

async function installTelegram({ token, publicBaseUrl, config, fetch, commandRunner }) {
  const existing = await listWorkerSecretNames(commandRunner, config);
  if (existing.has("TELEGRAM_BOT_TOKEN") || existing.has("TELEGRAM_WEBHOOK_SECRET")) {
    throw new TelegramSetupError(
      "Telegram integration is already configured; explicitly uninstall it before replacement.",
    );
  }

  const webhookSecret = randomBytes(32).toString("base64url");
  const installed = [];
  let vendorStarted = false;
  try {
    await putWorkerSecret(commandRunner, config, "TELEGRAM_BOT_TOKEN", token);
    installed.push("TELEGRAM_BOT_TOKEN");
    await putWorkerSecret(commandRunner, config, "TELEGRAM_WEBHOOK_SECRET", webhookSecret);
    installed.push("TELEGRAM_WEBHOOK_SECRET");
    vendorStarted = true;
    return await configureTelegram({ token, publicBaseUrl, webhookSecret, fetch });
  } catch (error) {
    if (vendorStarted) {
      try {
        await deleteWebhook(fetch, token);
      } catch {
        // Secret rollback must continue even if Telegram cleanup fails.
      }
    }
    await rollbackInstalledSecrets(commandRunner, config, installed);
    if (error instanceof TelegramSetupError) throw error;
    throw new TelegramSetupError("Unexpected setup failure.");
  }
}

async function uninstallTelegram({ token, config, fetch, commandRunner }) {
  let failed = false;
  try {
    await deleteWebhook(fetch, token);
  } catch {
    failed = true;
  }
  for (const name of ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN"]) {
    try {
      await deleteWorkerSecret(commandRunner, config, name);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new TelegramSetupError("Telegram uninstall did not complete.");
}

/** Runs complete non-interactive Telegram installation or removal with sanitized output. */
export async function runConfigureTelegramCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetch = globalThis.fetch,
  commandRunner = defaultCommandRunner,
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
} = {}) {
  try {
    const token = requireEnv(env, "TELEGRAM_BOT_TOKEN");
    const publicBaseUrl = requireEnv(env, "PUBLIC_BASE_URL");
    const config = requireEnv(env, "TELEGRAM_WRANGLER_CONFIG");
    if (!isAbsolute(config)) {
      throw new TelegramSetupError("TELEGRAM_WRANGLER_CONFIG must be absolute.");
    }

    if (argv.length === 1 && argv[0] === "--uninstall") {
      await uninstallTelegram({ token, config, fetch, commandRunner });
      stdout("Telegram integration uninstalled.\n");
      return 0;
    }
    if (argv.length > 0) throw new TelegramSetupError("Unknown Telegram setup option.");

    const result = await installTelegram({ token, publicBaseUrl, config, fetch, commandRunner });
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
