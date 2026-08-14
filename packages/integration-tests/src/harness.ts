// Boots the real workshop-backend alongside one or more real gatekeepers under wrangler's
// createTestHarness, so tests drive production code paths end to end.
//
// Parameterised over gatekeepers on purpose: a suite for a new gatekeeper should be "point the
// harness at the package and plug in a handler module", not a forked copy of this file. Per-vendor
// suites in consumer repos use this as-is.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";
import { runCustomBuildOnce, runFileBuildOnce } from "./custom-build.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Sibling of this package, whether that's `packages/` in this repo or `public/packages/` when a repo
// vendors this one as a submodule.
const WORKSHOP_DIR = resolve(HERE, "../../workshop-backend");
const REPO_ROOT = resolve(HERE, "../../..");
const UPDATE_MARKER = "__INTEGRATION_TEST_HARNESS_UPDATE";

/** Directory of the bundled fixture gatekeeper. See fixtures/gatekeeper-test/README-ish comments. */
export const TEST_GATEKEEPER_DIR = resolve(HERE, "../fixtures/gatekeeper-test");
export const TEST_GATEKEEPER_WORKER = "gatekeeper-test";
/** Service binding suffix, and therefore the vendor id the Workshop derives from it. */
export const TEST_GATEKEEPER_BINDING = "TEST";
export const TEST_VENDOR_ID = TEST_GATEKEEPER_BINDING.toLowerCase();

// Username that `vars.ADMINS` grants deployment-admin rights to, mirroring run-dev-server.js.
export const ADMIN_USERNAME = "admin";

// The slice of wrangler.jsonc the harness reads or rewrites. Loose on purpose: everything else a
// config declares flows through untouched, and wrangler re-validates the whole file when the worker
// boots -- this schema only guards the fields this file touches, so a broken config fails here with
// the field named rather than surviving a cast and failing somewhere stranger.
const WORKER_CONFIG = z.looseObject({
  name: z.string(),
  main: z.string(),
  build: z.looseObject({ command: z.string().optional(), cwd: z.string().optional() }).optional(),
  services: z.array(z.looseObject({
    binding: z.string(),
    service: z.string(),
    entrypoint: z.string().optional(),
  })).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  worker_loaders: z.unknown().optional(),
});

/** A parsed wrangler.jsonc, typed on the fields the harness (or a `patch` callback) works with. */
export type WorkerConfig = z.infer<typeof WORKER_CONFIG>;

export type GatekeeperSpec = {
  /**
   * Service binding suffix. `GATEKEEPER_<binding>` is what the Workshop scans for, and it lowercases
   * the suffix into the vendor id -- so "JIRA" here is the vendor id "jira" in every RPC.
   */
  binding: string;
  /** The gatekeeper package's directory, holding the wrangler.jsonc to boot. */
  dir: string;
  /** Adjust the gatekeeper's config after it's read, e.g. to set vars the tests depend on. */
  patch?: (config: WorkerConfig) => void;
};

// Read a checked-in wrangler.jsonc and make it usable as an *inline* harness config.
//
// A worker whose `main` is generated (capnweb-validate) needs `build.cwd` pinned to its own directory
// or the output lands in the wrong place -- run-dev-server.js pins it for the same reason. `main` then
// has to be absolute too: an inline config has no file path of its own, so wrangler resolves a
// relative `main` against the harness `root` rather than the worker directory.
function readWorkerConfig(dir: string): WorkerConfig {
  const path = join(dir, "wrangler.jsonc");
  const parsed = WORKER_CONFIG.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} is not a usable worker config: ${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  config.build = { ...config.build, cwd: dir };
  config.main = join(dir, config.main);
  return config;
}

async function prepareCustomBuild(config: WorkerConfig): Promise<void> {
  const build = config.build;
  if (!build?.command) return;

  await runCustomBuildOnce(build);
  delete build.command;
}

async function waitForRuntimeConfig(
    server: TestHarness, workerNames: string[], marker: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const envs = await Promise.all(workerNames.map(
        name => server.getWorker<Record<string, unknown>>(name).getEnv(),
      ));
      if (envs.every(env => env[UPDATE_MARKER] === marker)) return;
    } catch {
      // A runtime that is between bundles may temporarily reject environment inspection.
    }
    await new Promise(complete => setTimeout(complete, 10));
  }
  throw new Error("Timed out waiting for every harness worker to apply its runtime config");
}

function workshopConfig(
    gatekeepers: { binding: string; name: string }[],
    patch?: (config: WorkerConfig) => void,
    enableWorkerLoader = false): WorkerConfig {
  const config = readWorkerConfig(WORKSHOP_DIR);

  // The checked-in config declares no services; run-dev-server.js adds one per gatekeeper. We add
  // only the ones the suite asked for, so buildGatekeeperVendorMap() discovers exactly those vendors
  // and the observer-config prompt has no surprise rows.
  config.services = gatekeepers.map(gk => ({
    binding: `GATEKEEPER_${gk.binding}`,
    service: gk.name,
    entrypoint: "GatekeeperVendor",
  }));

  // No CF_ACCESS_AUD, so /api takes the unauthenticated path and password signup is available.
  config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME] };

  // Most suites never execute gadget code, so avoid starting the Worker Loader unless a capability-
  // graph test explicitly needs a real dynamic gadget Worker descendant.
  if (!enableWorkerLoader) delete config.worker_loaders;

  patch?.(config);
  return config;
}

export type Harness = {
  server: TestHarness;
  /** Base URL of the running server, e.g. http://127.0.0.1:1234. */
  url: URL;
  /**
   * Dispatch a request to a named worker's own HTTP entrypoint.
   *
   * Its host is never resolved -- the request goes straight to that worker -- so no `routes` config
   * is needed. The path still has to match whatever the worker expects.
   *
   * Typed as the harness's own dispatch signature: this package sees both Node and Workers global
   * types, so spelling out Request/Response here would pick the wrong flavour.
   */
  fetchWorker(name: string, ...args: Parameters<TestHarness["fetch"]>)
      : ReturnType<TestHarness["fetch"]>;
  /** Reload the Workshop's inline config while retaining this harness's durable storage. */
  updateWorkshop(patch: (config: WorkerConfig) => void): Promise<void>;
};

export async function startHarness(opts: {
  gatekeepers: GatekeeperSpec[];
  patchWorkshop?: (config: WorkerConfig) => void;
  /** Keep the real Worker Loader binding so tests can open dynamic gadget Worker descendants. */
  enableWorkerLoader?: boolean;
  /** Defaults to this repo's root. Override when a gatekeeper lives outside it. */
  root?: string;
}): Promise<Harness> {
  // Each gatekeeper's config is read (and patched) exactly once; the service binding below points at
  // the name the booted worker will actually carry, patches included.
  const gatekeepers = opts.gatekeepers.map(gk => {
    const config = readWorkerConfig(gk.dir);
    gk.patch?.(config);
    return { binding: gk.binding, name: config.name, config };
  });

  const root = opts.root ?? REPO_ROOT;
  let workshop = workshopConfig(gatekeepers, opts.patchWorkshop, opts.enableWorkerLoader);

  // This generated module is gitignored, so prepare it explicitly just as run-dev-server.js does.
  await runFileBuildOnce(
    process.execPath,
    [join(WORKSHOP_DIR, "scripts", "build-format-blueprints.mjs")],
    WORKSHOP_DIR,
  );

  // Inline config updates make Wrangler run every custom build again, including unchanged workers.
  // Build before workerd starts, then remove the commands so runtime-only updates cannot rewrite a
  // generated entrypoint while the active runtime is reloading it.
  await Promise.all([
    prepareCustomBuild(workshop),
    ...gatekeepers.map(({ config }) => prepareCustomBuild(config)),
  ]);

  const harnessOptions = () => ({
    root,
    // workshop-backend is primary, so unrouted requests (e.g. /api) go to it.
    workers: [
      { config: workshop },
      ...gatekeepers.map(({ config }) => ({ config })),
    ],
  });
  const server = createTestHarness(harnessOptions());

  const { url } = await server.listen();
  let updateSequence = 0;
  const workerNames = [workshop.name, ...gatekeepers.map(({ name }) => name)];
  return {
    server,
    url,
    fetchWorker: (name, ...args) => server.getWorker(name).fetch(...args),
    async updateWorkshop(patch) {
      workshop = structuredClone(workshop);
      patch(workshop);
      const marker = String(++updateSequence);
      workshop.vars = { ...workshop.vars, [UPDATE_MARKER]: marker };
      for (const { config } of gatekeepers) {
        config.vars = { ...config.vars, [UPDATE_MARKER]: marker };
      }
      await server.update(harnessOptions());
      await waitForRuntimeConfig(server, workerNames, marker);
    },
  };
}

/** Boot the Workshop with only the bundled fixture gatekeeper bound. */
export function startTestGatekeeperHarness(options: {
  patchWorkshop?: (config: WorkerConfig) => void;
  enableWorkerLoader?: boolean;
} = {}): Promise<Harness> {
  return startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    ...options,
  });
}
