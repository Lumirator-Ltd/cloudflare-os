// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

vi.mock('../main', () => ({ markConnectionRestored: () => {} }))

import { createRouter } from '../router'

describe('/admin/connectors route', () => {
  it('registers the full path directly under the root route', () => {
    const router = createRouter()
    const route = router.routesById['/admin_/connectors']

    expect(route.fullPath).toBe('/admin/connectors')
    expect(route.parentRoute.id).toBe('__root__')
    expect(route.parentRoute).toBe(router.routeTree)
  })
})
