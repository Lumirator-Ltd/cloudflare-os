import { describe, expect, it } from 'vitest'
import { Route } from './admin_.connectors'

describe('/admin/connectors route', () => {
  it('uses the non-nested admin connectors route', () => {
    expect(Route.options.component).toBeDefined()
  })
})
