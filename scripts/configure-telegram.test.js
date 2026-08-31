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
    TELEGRAM_WEBHOOK_SECRET: "cli-webhook-secret",
    PUBLIC_BASE_URL: "https://cli-workshop.example/",
  };

  it("prints only verified public setup details on success", async () => {
    const responses = [
      { ok: true, result: { id: 987654321, username: "verified_cli_bot" } },
      { ok: true, result: true },
      { ok: true, result: { url: "https://cli-workshop.example/api/telegram/webhook" } },
    ];
    const capture = captureCli();

    const exitCode = await runConfigureTelegramCli({
      env,
      fetch: async () => jsonResponse(responses.shift()),
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(capture.output(), {
      stdout: "Verified Telegram bot: @verified_cli_bot\n" +
          "Verified Telegram webhook: https://cli-workshop.example/api/telegram/webhook\n",
      stderr: "",
    });
    assertDoesNotLeak(capture.output(), [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET]);
  });

  for (const [name, fetch] of [
    ["Telegram 4xx", async () => new Response(
      `token=${env.TELEGRAM_BOT_TOKEN}&secret=${env.TELEGRAM_WEBHOOK_SECRET}`,
      { status: 401 })],
    ["malformed response", async () => jsonResponse({
      ok: true,
      result: {
        id: env.TELEGRAM_BOT_TOKEN,
        username: env.TELEGRAM_WEBHOOK_SECRET,
      },
    })],
    ["network error", async () => {
      throw new Error(`request failed for ${env.TELEGRAM_BOT_TOKEN} ${env.TELEGRAM_WEBHOOK_SECRET}`);
    }],
  ]) {
    it(`sanitizes ${name} output`, async () => {
      const capture = captureCli();

      const exitCode = await runConfigureTelegramCli({
        env,
        fetch,
        stdout: capture.stdout,
        stderr: capture.stderr,
      });

      assert.equal(exitCode, 1);
      assert.equal(capture.output().stdout, "");
      assert.match(capture.output().stderr, /^Telegram configuration failed:/);
      assertDoesNotLeak(capture.output(), [
        ...Object.values(env),
        env.PUBLIC_BASE_URL.replace(/\/$/, ""),
      ]);
    });
  }

  it("requires the orchestrator to supply the webhook secret", async () => {
    const capture = captureCli();
    let requested = false;

    const exitCode = await runConfigureTelegramCli({
      env: {
        TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
        PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
      },
      fetch: async () => {
        requested = true;
        throw new Error("unexpected request");
      },
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    assert.equal(exitCode, 1);
    assert.equal(requested, false);
    assert.equal(capture.output().stdout, "");
    assert.match(capture.output().stderr, /TELEGRAM_WEBHOOK_SECRET is required/);
    assertDoesNotLeak(capture.output(), Object.values(env));
  });
});
