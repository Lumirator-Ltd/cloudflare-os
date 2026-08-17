import type { RpcTarget } from "cloudflare:workers";

/** Whole-account access to contacts, companies, and deals in one connected HubSpot account. */
export interface HubSpotSession extends RpcTarget {
  /** Searches contacts by free text and returns one bounded page. */
  searchContacts(query: string, paging?: HubSpotSearchPaging): Promise<HubSpotSearchPage<HubSpotContact>>;

  /** Returns one contact by HubSpot record ID. */
  getContact(id: string): Promise<HubSpotContact>;

  /** Requests creation of a contact and returns a ticket for its outcome. */
  createContact(properties: HubSpotContactProperties): Promise<HubSpotMutationTicket>;

  /** Requests updates to a contact and returns a ticket for their outcome. */
  updateContact(id: string, properties: HubSpotContactProperties): Promise<HubSpotMutationTicket>;

  /** Searches companies by free text and returns one bounded page. */
  searchCompanies(query: string, paging?: HubSpotSearchPaging): Promise<HubSpotSearchPage<HubSpotCompany>>;

  /** Returns one company by HubSpot record ID. */
  getCompany(id: string): Promise<HubSpotCompany>;

  /** Requests creation of a company and returns a ticket for its outcome. */
  createCompany(properties: HubSpotCompanyProperties): Promise<HubSpotMutationTicket>;

  /** Requests updates to a company and returns a ticket for their outcome. */
  updateCompany(id: string, properties: HubSpotCompanyProperties): Promise<HubSpotMutationTicket>;

  /** Searches deals by free text and returns one bounded page. */
  searchDeals(query: string, paging?: HubSpotSearchPaging): Promise<HubSpotSearchPage<HubSpotDeal>>;

  /** Returns one deal by HubSpot record ID. */
  getDeal(id: string): Promise<HubSpotDeal>;

  /** Requests creation of a deal and returns a ticket for its outcome. */
  createDeal(properties: HubSpotDealProperties): Promise<HubSpotMutationTicket>;

  /** Requests updates to a deal and returns a ticket for their outcome. */
  updateDeal(id: string, properties: HubSpotDealProperties): Promise<HubSpotMutationTicket>;

  /** Returns the current outcome for a mutation ticket. */
  getMutationResult(ticket: HubSpotMutationTicket): Promise<HubSpotMutationResult>;
}

/** Cursor and page-size controls for a HubSpot CRM search. */
export type HubSpotSearchPaging = {
  /** Maximum records to return, from 1 through 100. */
  limit?: number;
  /** Digit-string cursor returned by the previous page. */
  after?: string;
};

/** One bounded page of HubSpot CRM records. */
export type HubSpotSearchPage<T> = {
  /** Records in this page. */
  results: T[];
  /** Digit-string cursor for the next page, when another page exists. */
  nextAfter?: string;
  /** Total matches reported by HubSpot. */
  total: number;
};

/** Curated writable and readable contact properties. */
export type HubSpotContactProperties = {
  /** Primary email address. */
  email?: string;
  /** First name. */
  firstname?: string;
  /** Last name. */
  lastname?: string;
  /** Primary phone number. */
  phone?: string;
  /** Mobile phone number. */
  mobilephone?: string;
  /** Job title. */
  jobtitle?: string;
  /** Company name. */
  company?: string;
  /** Website URL. */
  website?: string;
  /** HubSpot lifecycle stage. */
  lifecyclestage?: string;
};

/** One HubSpot contact with curated properties. */
export type HubSpotContact = {
  /** HubSpot record ID. */
  id: string;
  /** Curated contact properties. */
  properties: HubSpotContactProperties;
  /** Record creation time in ISO 8601 format. */
  createdAt: string;
  /** Last update time in ISO 8601 format. */
  updatedAt: string;
};

/** Curated writable and readable company properties. */
export type HubSpotCompanyProperties = {
  /** Company name. */
  name?: string;
  /** Primary domain. */
  domain?: string;
  /** Primary phone number. */
  phone?: string;
  /** Website URL. */
  website?: string;
  /** City. */
  city?: string;
  /** State or region. */
  state?: string;
  /** Country. */
  country?: string;
  /** Industry. */
  industry?: string;
  /** HubSpot lifecycle stage. */
  lifecyclestage?: string;
};

/** One HubSpot company with curated properties. */
export type HubSpotCompany = {
  /** HubSpot record ID. */
  id: string;
  /** Curated company properties. */
  properties: HubSpotCompanyProperties;
  /** Record creation time in ISO 8601 format. */
  createdAt: string;
  /** Last update time in ISO 8601 format. */
  updatedAt: string;
};

/** Curated writable and readable deal properties. */
export type HubSpotDealProperties = {
  /** Deal name. */
  dealname?: string;
  /** Deal amount in the account's currency. */
  amount?: string;
  /** Expected close date. */
  closedate?: string;
  /** Pipeline identifier. */
  pipeline?: string;
  /** Pipeline stage identifier. */
  dealstage?: string;
  /** Deal description. */
  description?: string;
  /** Deal type. */
  dealtype?: string;
};

/** One HubSpot deal with curated properties. */
export type HubSpotDeal = {
  /** HubSpot record ID. */
  id: string;
  /** Curated deal properties. */
  properties: HubSpotDealProperties;
  /** Record creation time in ISO 8601 format. */
  createdAt: string;
  /** Last update time in ISO 8601 format. */
  updatedAt: string;
};

/** CRM object type targeted by a mutation. */
export type HubSpotObjectType = "contact" | "company" | "deal";

/** CRM operation represented by a mutation ticket. */
export type HubSpotMutationOperation = "create" | "update";

/** Opaque handle returned when a CRM mutation is requested. */
export type HubSpotMutationTicket = {
  /** Gatekeeper-local mutation identifier. */
  id: number;
  /** Object type targeted by the mutation. */
  objectType: HubSpotObjectType;
  /** Requested operation. */
  operation: HubSpotMutationOperation;
};

/** Current outcome of a requested HubSpot CRM mutation. */
export type HubSpotMutationResult =
  | { status: "pending" }
  | { status: "rejected" }
  | { status: "failed"; message: string }
  | { status: "uncertain"; message: string }
  | { status: "ready"; objectType: HubSpotObjectType; recordId: string };
