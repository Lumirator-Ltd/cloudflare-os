/** Values used by the whole-account HubSpot configurator. */
export type HubSpotAccountConfiguratorValues = {
  /** Marks the no-input configurator as ready. */
  confirmed?: string | null;
};

/** Resolves the connected HubSpot account's canonical resource URL. */
export interface HubSpotAccountConfiguratorRpc {
  /** Returns the connected HubSpot account URL. */
  resourceUrl(): Promise<string>;
}
