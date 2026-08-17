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

  it("declares only write-only client credential inputs", () => {
    expect(readinessHelper()({})).toEqual({
      configured: false,
      inputs: [
        { name: "CLIENT_ID", label: "Client ID", secret: true },
        { name: "CLIENT_SECRET", label: "Client Secret", secret: true },
      ],
    });
  });
});
