import { describe, expect, it } from "vitest";
import * as gatekeeperContract from "@gadgets/workshop-shared/gatekeeper";

function readinessHelper(): (env: { CLIENT_ID?: string; CLIENT_SECRET?: string }) => unknown {
  const helper = Reflect.get(gatekeeperContract, "staticOauthConnectorConfiguration");
  expect(helper).toBeTypeOf("function");
  return helper as (env: { CLIENT_ID?: string; CLIENT_SECRET?: string }) => unknown;
}

describe("static OAuth connector readiness", () => {
  it("reports configured only when both credentials are present", () => {
    const configuration = readinessHelper();

    expect(configuration({ CLIENT_ID: "id", CLIENT_SECRET: "secret" })).toMatchObject({
      configured: true,
    });
    expect(configuration({ CLIENT_ID: "id" })).toMatchObject({ configured: false });
    expect(configuration({ CLIENT_SECRET: "secret" })).toMatchObject({ configured: false });
    expect(configuration({})).toMatchObject({ configured: false });
  });

  it("reports readiness without declaring control-plane secret names", () => {
    expect(readinessHelper()({})).toEqual({ configured: false });
  });

  it("centralizes the readiness guard and exact administrator guidance", () => {
    const message = Reflect.get(gatekeeperContract, "CONNECTOR_NOT_CONFIGURED_MESSAGE");
    const guard = Reflect.get(gatekeeperContract, "assertConnectorConfigured");

    expect(message).toBe(
      "This connector is not configured. Ask an administrator to configure it.",
    );
    expect(guard).toBeTypeOf("function");
    expect(() => guard({
      displayName: "GitHub",
      url: "https://github.com",
      configuration: { configured: false },
    })).toThrow(message);
    expect(() => guard({ displayName: "Context", url: "https://example.com" })).not.toThrow();
  });
});
