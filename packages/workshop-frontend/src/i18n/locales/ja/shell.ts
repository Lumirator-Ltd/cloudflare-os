import type { CatalogShape } from "../catalog";
import type { enShell } from "../en/shell";

export const jaShell = {} as const satisfies CatalogShape<typeof enShell>;
