import type { TranslationCatalog } from "./en";
import { jaAdmin } from "./ja/admin";
import { jaChat } from "./ja/chat";
import { jaCommon } from "./ja/common";
import { jaShell } from "./ja/shell";
import { jaWorkspace } from "./ja/workspace";

export const ja = {
  ...jaCommon,
  ...jaChat,
  ...jaShell,
  ...jaWorkspace,
  ...jaAdmin,
} as const satisfies TranslationCatalog;
