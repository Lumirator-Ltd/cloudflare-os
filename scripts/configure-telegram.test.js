import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  configureTelegram,
  runConfigureTelegramCli,
} from "./configure-telegram.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("configureTelegram", () => {
  it("derives bot identity and registers the exact verified webhook", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 123456789, username: "gadget_helper_bot" } });
      }
      if (url.endsWith("/setWebhook")) {
        return jsonResponse({ ok: true, result: true });
      }
      return jsonResponse({
        ok: true,
        result: { url: "https://workshop.example/api/telegram/webhook" },
      });
    };

    const result = await configureTelegram({
      token: "123456789:test-token-value",
      publicBaseUrl: "https://workshop.example///",
      webhookSecret: "test-webhook-secret",
      fetch,
    });

    assert.deepEqual(result, {
      botId: 123456789,
      botUsername: "gadget_helper_bot",
      webhookUrl: "https://workshop.example/api/telegram/webhook",
      webhookSecret: "test-webhook-secret",
    });
    assert.deepEqual(calls.map(({ url }) => url), [
      "https://api.telegram.org/bot123456789:test-token-value/getMe",
      "https://api.telegram.org/bot123456789:test-token-value/setWebhook",
      "https://api.telegram.org/bot123456789:test-token-value/getWebhookInfo",
    ]);
    assert.deepEqual(calls.map(({ init }) => init.redirect), ["error", "error", "error"]);
    assert.equal(calls[1].init.method, "POST");
    assert.deepEqual(calls[1].init.headers, { "content-type": "application/json" });
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      url: "https://workshop.example/api/telegram/webhook",
      secret_token: "test-webhook-secret",
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
  });

  it("generates a 32-byte base64url webhook secret when omitted", async () => {
    let registeredSecret;
    const fetch = async (url, init) => {
      if (url.endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 42, username: "generated_secret_bot" } });
      }
      if (url.endsWith("/setWebhook")) {
        registeredSecret = JSON.parse(init.body).secret_token;
        return jsonResponse({ ok: true, result: true });
      }
      return jsonResponse({
        ok: true,
        result: { url: "https://workshop.example/api/telegram/webhook" },
      });
    };

    const result = await configureTelegram({
      token: "42:token",
      publicBaseUrl: "https://workshop.example",
      fetch,
    });

    assert.match(result.webhookSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(result.webhookSecret, "base64url").byteLength, 32);
    assert.equal(registeredSecret, result.webhookSecret);
  });

  for (const identity of [
    { id: "42", username: "invalid_id_bot" },
    { id: 42, username: "" },
  ]) {
    it(`rejects malformed getMe identity ${JSON.stringify(identity)}`, async () => {
      await assert.rejects(configureTelegram({
        token: "42:token",
        publicBaseUrl: "https://workshop.example",
        webhookSecret: "webhook-secret",
        fetch: async () => jsonResponse({ ok: true, result: identity }),
      }), /Telegram getMe returned an invalid bot identity/);
    });
  }

  it("fails closed when Telegram reports a different webhook URL", async () => {
    const responses = [
      { ok: true, result: { id: 42, username: "mismatch_bot" } },
      { ok: true, result: true },
      { ok: true, result: { url: "https://other.example/api/telegram/webhook" } },
    ];

    await assert.rejects(configureTelegram({
      token: "42:token",
      publicBaseUrl: "https://workshop.example",
      webhookSecret: "webhook-secret",
      fetch: async () => jsonResponse(responses.shift()),
    }), /Telegram webhook verification failed/);
  });

  it("fails closed when Telegram includes a last error field", async () => {
    const responses = [
      { ok: true, result: { id: 42, username: "delivery_error_bot" } },
      { ok: true, result: true },
      {
        ok: true,
        result: {
          url: "https://workshop.example/api/telegram/webhook",
          last_error_message: "",
        },
      },
    ];

    await assert.rejects(configureTelegram({
      token: "42:token",
      publicBaseUrl: "https://workshop.example",
      webhookSecret: "webhook-secret",
      fetch: async () => jsonResponse(responses.shift()),
    }), /Telegram webhook verification failed/);
  });
});

function captureCli() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
    output: () => ({ stdout, stderr }),
  };
}

function assertDoesNotLeak(output, values) {
  for (const value of values) {
    assert.equal(`${output.stdout}\n${output.stderr}`.includes(value), false);
  }
}

describe("runConfigureTelegramCli", () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "987654321:cli-token-secret",
    PUBLIC_BASE_URL: "https://cli-workshop.example/",
    TELEGRAM_WRANGLER_CONFIG: "/deploy/workshop-backend/wrangler.jsonc",
  };

  it("installs both Worker secrets before registering the webhook", async () => {
    const commands = [];
    const vendorCalls = [];
    const commandRunner = async (command, args, options) => {
      commands.push({ command, args, stdin: options.stdin });
    };
    const fetch = async (url, init) => {
      vendorCalls.push({ url, init });
      assert.equal(commands.length, 2);
      if (url.endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 987654321, username: "verified_cli_bot" } });
      }
      if (url.endsWith("/setWebhook")) return jsonResponse({ ok: true, result: true });
      return jsonResponse({
        ok: true,
        result: { url: "https://cli-workshop.example/api/telegram/webhook" },
      });
    };
    const capture = captureCli();

    const exitCode = await runConfigureTelegramCli({
      env,
      fetch,
      commandRunner,
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(commands.map(({ command, args }) => [command, args]), [
      ["pnpm", ["exec", "wrangler", "secret", "put", "TELEGRAM_BOT_TOKEN", "--config", env.TELEGRAM_WRANGLER_CONFIG]],
      ["pnpm", ["exec", "wrangler", "secret", "put", "TELEGRAM_WEBHOOK_SECRET", "--config", env.TELEGRAM_WRANGLER_CONFIG]],
    ]);
    assert.equal(commands[0].stdin, `${env.TELEGRAM_BOT_TOKEN}\n`);
    const generatedSecret = commands[1].stdin.trim();
    assert.match(generatedSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(commands.map(({ args }) => args)).includes(env.TELEGRAM_BOT_TOKEN), false);
    assert.equal(JSON.stringify(commands.map(({ args }) => args)).includes(generatedSecret), false);
    assert.equal(JSON.parse(vendorCalls[1].init.body).secret_token, generatedSecret);
    assert.deepEqual(capture.output(), {
      stdout: "Verified Telegram bot: @verified_cli_bot\n" +
          "Verified Telegram webhook: https://cli-workshop.example/api/telegram/webhook\n",
      stderr: "",
    });
    assertDoesNotLeak(capture.output(), [env.TELEGRAM_BOT_TOKEN, generatedSecret]);
  });

  it("rolls back installed secrets when webhook verification fails", async () => {
    const commands = [];
    const responses = [
      { ok: true, result: { id: 42, username: "mismatch_bot" } },
      { ok: true, result: true },
      { ok: true, result: { url: "https://other.example/api/telegram/webhook" } },
      { ok: true, result: true },
    ];
    const capture = captureCli();

    const exitCode = await runConfigureTelegramCli({
      env,
      fetch: async () => jsonResponse(responses.shift()),
      commandRunner: async (command, args, options) => {
        commands.push({ command, args, stdin: options.stdin });
      },
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(commands.map(({ args }) => args.slice(1, 5)), [
      ["wrangler", "secret", "put", "TELEGRAM_BOT_TOKEN"],
      ["wrangler", "secret", "put", "TELEGRAM_WEBHOOK_SECRET"],
      ["wrangler", "secret", "delete", "TELEGRAM_WEBHOOK_SECRET"],
      ["wrangler", "secret", "delete", "TELEGRAM_BOT_TOKEN"],
    ]);
    assert.equal(capture.output().stdout, "");
    assert.match(capture.output().stderr, /^Telegram configuration failed:/);
    const generatedSecret = commands[1].stdin.trim();
    assertDoesNotLeak(capture.output(), [env.TELEGRAM_BOT_TOKEN, generatedSecret]);
  });

  it("rolls back only the first secret when the second put fails", async () => {
    const commands = [];
    const capture = captureCli();
    let commandCount = 0;

    const exitCode = await runConfigureTelegramCli({
      env,
      fetch: async () => { throw new Error("vendor must not be called"); },
      commandRunner: async (command, args, options) => {
        commands.push({ command, args, stdin: options.stdin });
        commandCount++;
        if (commandCount === 2) {
          throw new Error(`runner exposed ${env.TELEGRAM_BOT_TOKEN} ${options.stdin}`);
        }
      },
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(commands.map(({ args }) => args[3] + ":" + args[4]), [
      "put:TELEGRAM_BOT_TOKEN",
      "put:TELEGRAM_WEBHOOK_SECRET",
      "delete:TELEGRAM_BOT_TOKEN",
    ]);
    assertDoesNotLeak(capture.output(), [env.TELEGRAM_BOT_TOKEN, commands[1].stdin.trim()]);
  });

  it("uninstalls the webhook before deleting both Worker secrets", async () => {
    const events = [];
    const capture = captureCli();

    const exitCode = await runConfigureTelegramCli({
      argv: ["--uninstall"],
      env,
      fetch: async (url) => {
        events.push(`vendor:${url.slice(url.lastIndexOf("/") + 1)}`);
        return jsonResponse({ ok: true, result: true });
      },
      commandRunner: async (_command, args) => {
        events.push(`command:${args[3]}:${args[4]}`);
      },
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(events, [
      "vendor:deleteWebhook",
      "command:delete:TELEGRAM_WEBHOOK_SECRET",
      "command:delete:TELEGRAM_BOT_TOKEN",
    ]);
    assert.deepEqual(capture.output(), {
      stdout: "Telegram integration uninstalled.\n",
      stderr: "",
    });
    assertDoesNotLeak(capture.output(), Object.values(env));
  });

  it("rejects a relative deployment config before handling secrets", async () => {
    const capture = captureCli();
    let called = false;

    const exitCode = await runConfigureTelegramCli({
      env: { ...env, TELEGRAM_WRANGLER_CONFIG: "relative/wrangler.jsonc" },
      fetch: async () => { called = true; throw new Error("unexpected"); },
      commandRunner: async () => { called = true; },
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.match(capture.output().stderr, /absolute/);
    assertDoesNotLeak(capture.output(), Object.values(env));
  });

  it("sanitizes command and vendor failures", async () => {
    for (const failure of ["command", "vendor"]) {
      const capture = captureCli();
      const commands = [];
      const exitCode = await runConfigureTelegramCli({
        env,
        fetch: async () => {
          throw new Error(`vendor exposed ${env.TELEGRAM_BOT_TOKEN}`);
        },
        commandRunner: async (command, args, options) => {
          commands.push({ command, args, stdin: options.stdin });
          if (failure === "command") {
            throw new Error(`command exposed ${env.TELEGRAM_BOT_TOKEN} ${options.stdin}`);
          }
        },
        stdout: capture.stdout,
        stderr: capture.stderr,
      });

      assert.equal(exitCode, 1);
      assert.equal(capture.output().stdout, "");
      assert.match(capture.output().stderr, /^Telegram configuration failed:/);
      assertDoesNotLeak(capture.output(), [
        env.TELEGRAM_BOT_TOKEN,
        ...commands.map(({ stdin }) => stdin?.trim()).filter(Boolean),
      ]);
    }
  });
});
