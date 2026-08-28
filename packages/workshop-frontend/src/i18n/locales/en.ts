import type { CatalogShape } from "./catalog";
import { enAdmin } from "./en/admin";
import { enChat } from "./en/chat";
import { enCommon } from "./en/common";
import { enShell } from "./en/shell";
import { enWorkspace } from "./en/workspace";

export const en = {
  ...enCommon,
  ...enChat,
  ...enShell,
  ...enWorkspace,
  ...enAdmin,
} as const;

export type TranslationCatalog = CatalogShape<typeof en>;
