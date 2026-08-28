export type CatalogShape<Value> = Value extends string
  ? string
  : { [Key in keyof Value]: CatalogShape<Value[Key]> };
