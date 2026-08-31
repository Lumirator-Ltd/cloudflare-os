import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: DurableObjectState;
    protected env: Cloudflare.Env;

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { IdentityRegistry, canonicalizeVerifiedEmail } from "../src/identity-registry.js";
import { makeMockStorage } from "./mock-storage.js";

const TELEGRAM = "telegram";
const tenMinutes = 10 * 60_000;

type RegistryHarness = {
  registry: IdentityRegistry;
  writes: ReturnType<typeof vi.fn>;
  deletes: ReturnType<typeof vi.fn>;
};

function makeRegistry(): RegistryHarness {
  const storage = makeMockStorage();
  const put = storage.kv.put.bind(storage.kv);
  const writes = vi.fn((key: string, value: unknown) => put(key, value));
  const remove = storage.kv.delete.bind(storage.kv);
  const deletes = vi.fn((key: string) => remove(key));
  storage.kv.put = writes;
  storage.kv.delete = deletes;
  const user = { initializeIdentity: vi.fn().mockResolvedValue(undefined) };
  const state = {
    storage,
    exports: {
      UserDurableObject: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => user),
      },
    },
  } as unknown as DurableObjectState;
  return {
    registry: new IdentityRegistry(state, {} as Cloudflare.Env),
    writes,
    deletes,
  };
}

async function createIdentity(
  registry: IdentityRegistry,
  subject: string,
  email = `${subject}@example.com`,
) {
  return registry.resolveClerkIdentity(subject, email, true);
}

async function link(
  registry: IdentityRegistry,
  internalUserId: string,
  identityVersion: number,
  externalSubject: string,
) {
  const started = await registry.startExternalLink(
    internalUserId,
    identityVersion,
    TELEGRAM,
  );
  return registry.completeExternalLink(TELEGRAM, started.token, externalSubject);
}

describe("canonicalizeVerifiedEmail", () => {
  it("trims surrounding whitespace and lowercases the address", () => {
    expect(canonicalizeVerifiedEmail("  Mixed.Case+Tag@Example.COM\t"))
      .toBe("mixed.case+tag@example.com");
  });

  it("does not rewrite dots or plus suffixes", () => {
    expect(canonicalizeVerifiedEmail("First.Last+folder@gmail.com"))
      .toBe("first.last+folder@gmail.com");
  });
});

describe("external identity links", () => {
  it("creates a ten-minute 32-byte token while persisting only its digest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const { registry, writes } = makeRegistry();
      const identity = await createIdentity(registry, "token-user");

      const started = await registry.startExternalLink(
        identity.internalUserId,
        identity.identityVersion,
        TELEGRAM,
      );

      expect(started.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.expiresAt).toEqual(new Date(Date.now() + tenMinutes));
      expect(JSON.stringify(writes.mock.calls)).not.toContain(started.token);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects expired tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const { registry } = makeRegistry();
      const identity = await createIdentity(registry, "expiry-user");
      const started = await registry.startExternalLink(
        identity.internalUserId,
        identity.identityVersion,
        TELEGRAM,
      );

      await vi.advanceTimersByTimeAsync(tenMinutes + 1);

      await expect(registry.completeExternalLink(TELEGRAM, started.token, "telegram-expired"))
        .rejects.toThrow();
      expect(await registry.findInternalUserIdByExternalSubject(
        TELEGRAM,
        "telegram-expired",
      )).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds indexed expiry cleanup to one batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const { registry, deletes } = makeRegistry();
      for (let index = 0; index < 101; index++) {
        const identity = await createIdentity(registry, `cleanup-${index}`);
        await registry.startExternalLink(
          identity.internalUserId,
          identity.identityVersion,
          TELEGRAM,
        );
      }
      const next = await createIdentity(registry, "cleanup-next");
      deletes.mockClear();
      await vi.advanceTimersByTimeAsync(tenMinutes + 1);

      await registry.startExternalLink(
        next.internalUserId,
        next.identityVersion,
        TELEGRAM,
      );

      const deletedTokenRecords = deletes.mock.calls.filter(
        ([key]) => typeof key === "string" && key.startsWith("externalLinkTokens:"),
      );
      expect(deletedTokenRecords).toHaveLength(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the latest pending token for a user and source", async () => {
    const { registry } = makeRegistry();
    const identity = await createIdentity(registry, "latest-user");
    const first = await registry.startExternalLink(
      identity.internalUserId,
      identity.identityVersion,
      TELEGRAM,
    );
    const second = await registry.startExternalLink(
      identity.internalUserId,
      identity.identityVersion,
      TELEGRAM,
    );

    await expect(registry.completeExternalLink(TELEGRAM, first.token, "telegram-old"))
      .rejects.toThrow();
    await expect(registry.completeExternalLink(TELEGRAM, second.token, "telegram-current"))
      .resolves.toBe(identity.internalUserId);
  });

  it("consumes a token exactly once, including concurrent completion", async () => {
    const { registry } = makeRegistry();
    const identity = await createIdentity(registry, "single-use-user");
    const started = await registry.startExternalLink(
      identity.internalUserId,
      identity.identityVersion,
      TELEGRAM,
    );

    const results = await Promise.allSettled([
      registry.completeExternalLink(TELEGRAM, started.token, "telegram-single-use"),
      registry.completeExternalLink(TELEGRAM, started.token, "telegram-single-use"),
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    await expect(registry.completeExternalLink(
      TELEGRAM,
      started.token,
      "telegram-single-use",
    )).rejects.toThrow();
  });

  it("replays a source-scoped completion after commit without consuming the token again", async () => {
    const { registry, deletes, writes } = makeRegistry();
    const identity = await createIdentity(registry, "idempotent-link-user");
    const started = await registry.startExternalLink(
      identity.internalUserId,
      identity.identityVersion,
      TELEGRAM,
    );

    await expect(registry.completeExternalLink(
      TELEGRAM,
      started.token,
      "telegram-idempotent",
      "update-42",
    )).resolves.toBe(identity.internalUserId);
    const tokenDeletes = () => deletes.mock.calls.filter(
      ([key]) => typeof key === "string" && key.startsWith("externalLinkTokens:"),
    );
    expect(tokenDeletes()).toHaveLength(1);

    await expect(registry.completeExternalLink(
      TELEGRAM,
      started.token,
      "telegram-idempotent",
      "update-42",
    )).resolves.toBe(identity.internalUserId);
    expect(tokenDeletes()).toHaveLength(1);
    expect(JSON.stringify(writes.mock.calls)).not.toContain(started.token);

    await expect(registry.completeExternalLink(
      TELEGRAM,
      started.token,
      "different-subject",
      "update-42",
    )).resolves.toBeNull();
    await expect(registry.completeExternalLink(
      "different-source",
      started.token,
      "telegram-idempotent",
      "update-42",
    )).resolves.toBeNull();
  });

  it("expires completion receipts after the 24-hour replay horizon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    try {
      const { registry } = makeRegistry();
      const identity = await createIdentity(registry, "receipt-expiry-user");
      const started = await registry.startExternalLink(
        identity.internalUserId,
        identity.identityVersion,
        TELEGRAM,
      );
      await registry.completeExternalLink(
        TELEGRAM,
        started.token,
        "telegram-receipt-expiry",
        "update-expiry",
      );

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);

      await expect(registry.completeExternalLink(
        TELEGRAM,
        started.token,
        "telegram-receipt-expiry",
        "update-expiry",
      )).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when an external subject belongs to another internal user", async () => {
    const { registry } = makeRegistry();
    const first = await createIdentity(registry, "collision-first");
    const second = await createIdentity(registry, "collision-second");
    await link(
      registry,
      first.internalUserId,
      first.identityVersion,
      "telegram-collision",
    );
    const secondToken = await registry.startExternalLink(
      second.internalUserId,
      second.identityVersion,
      TELEGRAM,
    );

    await expect(registry.completeExternalLink(
      TELEGRAM,
      secondToken.token,
      "telegram-collision",
    )).rejects.toThrow();
    expect(await registry.findInternalUserIdByExternalSubject(
      TELEGRAM,
      "telegram-collision",
    )).toBe(first.internalUserId);
    expect(await registry.getExternalLinkStatus(
      second.internalUserId,
      second.identityVersion,
      TELEGRAM,
    )).toEqual({ connected: false });
  });

  it("replaces the same user's previous source mapping without exposing either subject", async () => {
    const { registry } = makeRegistry();
    const identity = await createIdentity(registry, "relink-user");
    await link(registry, identity.internalUserId, identity.identityVersion, "telegram-first");
    await link(registry, identity.internalUserId, identity.identityVersion, "telegram-second");

    expect(await registry.findInternalUserIdByExternalSubject(TELEGRAM, "telegram-first"))
      .toBeNull();
    expect(await registry.findInternalUserIdByExternalSubject(TELEGRAM, "telegram-second"))
      .toBe(identity.internalUserId);
    expect(await registry.getExternalLinkStatus(
      identity.internalUserId,
      identity.identityVersion,
      TELEGRAM,
    )).toEqual({ connected: true });
  });

  it("unlink removes the mapping and invalidates every pending token for that source", async () => {
    const { registry } = makeRegistry();
    const identity = await createIdentity(registry, "unlink-user");
    await link(registry, identity.internalUserId, identity.identityVersion, "telegram-unlink");
    const pending = await registry.startExternalLink(
      identity.internalUserId,
      identity.identityVersion,
      TELEGRAM,
    );

    await registry.unlinkExternalIdentity(
      identity.internalUserId,
      identity.identityVersion,
      TELEGRAM,
    );

    expect(await registry.findInternalUserIdByExternalSubject(TELEGRAM, "telegram-unlink"))
      .toBeNull();
    await expect(registry.completeExternalLink(
      TELEGRAM,
      pending.token,
      "telegram-after-unlink",
    )).rejects.toThrow();
  });

  it("requires an active identity at the exact version for start and completion", async () => {
    const { registry } = makeRegistry();
    const moving = await createIdentity(registry, "moving-user", "moving-old@example.com");

    await expect(registry.startExternalLink(
      moving.internalUserId,
      moving.identityVersion + 1,
      TELEGRAM,
    )).rejects.toThrow();

    const stale = await registry.startExternalLink(
      moving.internalUserId,
      moving.identityVersion,
      TELEGRAM,
    );
    const moved = await registry.resolveClerkIdentity(
      "moving-user",
      "moving-new@example.com",
      true,
    );
    expect(moved.identityVersion).toBe(moving.identityVersion + 1);
    await expect(registry.completeExternalLink(
      TELEGRAM,
      stale.token,
      "telegram-stale-version",
    )).rejects.toThrow();

    const locked = await createIdentity(registry, "locked-user", "locked@example.com");
    await createIdentity(registry, "claim-owner", "claimed@example.com");
    const beforeLock = await registry.startExternalLink(
      locked.internalUserId,
      locked.identityVersion,
      TELEGRAM,
    );
    await expect(registry.resolveClerkIdentity(
      "locked-user",
      "claimed@example.com",
      true,
    )).rejects.toThrow();
    await expect(registry.completeExternalLink(
      TELEGRAM,
      beforeLock.token,
      "telegram-locked",
    )).rejects.toThrow();
  });

  it("keeps external links separate from authentication subject keys", async () => {
    const { registry } = makeRegistry();
    const telegramOwner = await createIdentity(registry, "telegram-owner");
    await link(
      registry,
      telegramOwner.internalUserId,
      telegramOwner.identityVersion,
      "shared-provider-subject",
    );

    const clerkOwner = await createIdentity(
      registry,
      "shared-provider-subject",
      "different@example.com",
    );

    expect(clerkOwner.internalUserId).not.toBe(telegramOwner.internalUserId);
  });

  it("backend lookup excludes inactive identities", async () => {
    const { registry } = makeRegistry();
    const identity = await createIdentity(registry, "lookup-lock", "lookup-lock@example.com");
    await link(
      registry,
      identity.internalUserId,
      identity.identityVersion,
      "telegram-inactive",
    );
    await createIdentity(registry, "lookup-claim", "lookup-claimed@example.com");
    await expect(registry.resolveClerkIdentity(
      "lookup-lock",
      "lookup-claimed@example.com",
      true,
    )).rejects.toThrow();

    expect(await registry.findInternalUserIdByExternalSubject(
      TELEGRAM,
      "telegram-inactive",
    )).toBeNull();
  });
});
