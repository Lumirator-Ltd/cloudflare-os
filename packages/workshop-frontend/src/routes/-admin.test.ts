import { describe, expect, it } from 'vitest'
import { Route } from './admin'

describe('/admin search', () => {
  it('validates supported tabs and defaults missing or unknown values to General', () => {
    const validator = Route.options.validateSearch

    expect(validator).toBeTypeOf('function')
    if (typeof validator !== 'function') return
    const validateSearch = validator as (search: Record<string, unknown>) => unknown

    expect(validateSearch({})).toEqual({ tab: 'general' })
    expect(validateSearch({ tab: 'general' })).toEqual({ tab: 'general' })
    expect(validateSearch({ tab: 'gatekeepers' })).toEqual({ tab: 'gatekeepers' })
    expect(validateSearch({ tab: 'formats' })).toEqual({ tab: 'formats' })
    expect(validateSearch({ tab: 'access' })).toEqual({ tab: 'access' })
    expect(validateSearch({ tab: 'unknown' })).toEqual({ tab: 'general' })
  })
})
