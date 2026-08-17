import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

type Env = Cloudflare.Env;

export default {
  fetch(): Response {
    return new Response("HubSpot gatekeeper is not implemented.", { status: 501 });
  },
};

/** Stores one connected HubSpot account's state. */
export class UserAccount extends DurableObject<Env> {}

/** Hosts one Gadget's whole-account HubSpot binding. */
export class HubSpotGatekeeperImpl extends DurableObject<Env> {}

/** Exposes the HubSpot connector to the Workshop. */
export class GatekeeperVendor extends WorkerEntrypoint<Env> {}
