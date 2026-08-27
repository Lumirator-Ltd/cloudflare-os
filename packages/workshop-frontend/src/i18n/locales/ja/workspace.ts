import type { CatalogShape } from "../catalog";
import type { enWorkspace } from "../en/workspace";

export const jaWorkspace = {} as const satisfies CatalogShape<typeof enWorkspace>;
