import { createLogger } from "@gadgets/backend-utils/logger";
import { initialAdminConfigDigest, parseInitialAdminConfig } from "./admin-bootstrap.js";

type AdminBootstrapLogFields = {
  errorCode: "ADMIN_BOOTSTRAP_FAILED";
  digestPrefix: string;
};

const bootstrapLogger = createLogger<AdminBootstrapLogFields>({
  component: "workshop.server.bootstrap",
});

let adminBootstrapPromise: Promise<void> | undefined;

async function adminBootstrapDigestPrefix(value: unknown): Promise<string> {
  let initial = parseInitialAdminConfig(value);
  if (initial) return (await initialAdminConfigDigest(initial)).slice(0, 12);

  let serialized = JSON.stringify(value) ?? "undefined";
  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return new Uint8Array(digest).toHex().slice(0, 12);
}

export function assertAdminBootstrap(
    env: Cloudflare.Env,
    ctx: ExecutionContext): Promise<void> {
  let initial = env.INITIAL_ADMIN_CONFIG;
  if (initial === undefined) return Promise.resolve();
  if (adminBootstrapPromise) return adminBootstrapPromise;

  let digestPrefix = "unavailable";
  const attempt: Promise<void> = (async () => {
    try {
      digestPrefix = await adminBootstrapDigestPrefix(initial);
      await ctx.exports.AdminSettings.getByName("").ensureInitialAdminConfig(initial);
    } catch {
      if (adminBootstrapPromise === attempt) adminBootstrapPromise = undefined;
      bootstrapLogger.error("deployment admin bootstrap failed", {
        event: "admin.bootstrap.failed",
        errorCode: "ADMIN_BOOTSTRAP_FAILED",
        digestPrefix,
      });
      throw new Error("Deployment initialization pending.");
    }
  })();
  adminBootstrapPromise = attempt;
  return attempt;
}

export function resetAdminBootstrapCacheForTest(): void {
  adminBootstrapPromise = undefined;
}
