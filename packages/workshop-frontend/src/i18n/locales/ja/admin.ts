import type { CatalogShape } from "../catalog";
import type { enAdmin } from "../en/admin";

export const jaAdmin = {} as const satisfies CatalogShape<typeof enAdmin>;
