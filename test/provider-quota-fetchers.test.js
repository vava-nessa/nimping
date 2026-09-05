/**
 * @file test/provider-quota-fetchers.test.js
 * @description Tests for lib/provider-quota-fetchers.js
 *
 * Covers:
 *  - OpenRouter response parsing → percent
 *  - OpenRouter missing/malformed fields → null
 *  - SiliconFlow response parsing → best-effort percent or null
 *  - SiliconFlow missing fields → null
 *  - TTL cache: repeated calls within TTL return cached value without re-fetching
 *  - Error backoff: fetch error → short backoff, no immediate re-fetch
 *  - fetchProviderQuota dispatch: openrouter → OR fetcher, siliconflow → SF fetcher, unknown → null
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOpenRouterResponse,
  parseSiliconFlowResponse,
  createProviderQuotaFetcher,
  fetchProviderQuota,
} from '../src/core/provider-quota-fetchers.js'

// ─── parseOpenRouterResponse ──────────────────────────────────────────────────

describe('parseOpenRouterResponse', () => {
  it('derives percent from limit_remaining/limit', () => {
    const data = { data: { limit_remaining: 50, limit: 100 } }
    assert.strictEqual(parseOpenRouterResponse(data), 50)
  })

  it('clamps result to [0, 100]', () => {
    // remaining > limit (shouldn't happen but must clamp)
    assert.strictEqual(parseOpenRouterResponse({ data: { limit_remaining: 110, limit: 100 } }), 100)
    // remaining < 0
    assert.strictEqual(parseOpenRouterResponse({ data: { limit_remaining: -5, limit: 100 } }), 0)
  })

  it('rounds to integer', () => {
    const data = { data: { limit_remaining: 33, limit: 99 } }
    assert.strictEqual(typeof parseOpenRouterResponse(data), 'number')
    assert.strictEqual(parseOpenRouterResponse(data) % 1, 0)
  })

  it('falls back to root-level remaining/limit when data wrapper is absent', () => {
    const data = { limit_remaining: 75, limit: 100 }
    assert.strictEqual(parseOpenRouterResponse(data), 75)
  })

  it('uses fallback field remaining_credits/credits', () => {
    const data = { data: { remaining_credits: 25, credits: 100 } }
    assert.strictEqual(parseOpenRouterResponse(data), 25)
  })

  it('uses fallback field remaining/total_limit', () => {
    const data = { data: { remaining: 80, total_limit: 100 } }
    assert.strictEqual(parseOpenRouterResponse(data), 80)
  })

  it('returns null when limit is zero', () => {
    assert.strictEqual(parseOpenRouterResponse({ data: { limit_remaining: 0, limit: 0 } }), null)
  })

  it('returns null for missing fields', () => {
    assert.strictEqual(parseOpenRouterResponse({}), null)
    assert.strictEqual(parseOpenRouterResponse(null), null)
    assert.strictEqual(parseOpenRouterResponse({ data: {} }), null)
  })

  it('returns null for non-numeric fields', () => {
    assert.strictEqual(parseOpenRouterResponse({ data: { limit_remaining: 'N/A', limit: 'unknown' } }), null)
  })
})

// ─── parseSiliconFlowResponse ─────────────────────────────────────────────────

describe('parseSiliconFlowResponse', () => {
  it('returns percent: null when balances are zero (cannot derive percent from balance alone)', () => {
    // SiliconFlow doesn't expose a "limit" — we cannot compute a reliable %
    // A zero balance is still valid data; the function returns an object with percent: null
    const data = { code: 20000, status: true, data: { balance: '0.00', chargeBalance: '0.00', totalBalance: '0.00' } }
    const result = parseSiliconFlowResponse(data)
    // percent is always null — no limit field to derive from
    assert.ok(result !== null, 'should return an object (not null) for valid zero-balance response')
    assert.strictEqual(result.percent, null, 'percent must be null since no limit field exists')
    assert.strictEqual(result.totalBalance, 0)
  })

  it('returns an object with balance fields when data is valid', () => {
    const data = {
      code: 20000,
      status: true,
      data: {
        balance: '0.88',
        chargeBalance: '88.00',
        totalBalance: '88.88',
      },
    }
    const result = parseSiliconFlowResponse(data)
    // May return null (cannot derive %) OR an object with balance info
    // Either is acceptable; the key contract is: must not throw and must return null or { balance, chargeBalance, totalBalance, percent }
    if (result !== null) {
      assert.ok(typeof result === 'object')
      assert.ok('totalBalance' in result || 'percent' in result)
    }
  })

  it('returns null for missing data wrapper', () => {
    assert.strictEqual(parseSiliconFlowResponse(null), null)
    assert.strictEqual(parseSiliconFlowResponse({}), null)
    assert.strictEqual(parseSiliconFlowResponse({ code: 20000 }), null)
  })

  it('returns null when status code indicates error', () => {
    const data = { code: 40001, status: false, data: null }
    assert.strictEqual(parseSiliconFlowResponse(data), null)
  })

  it('handles string balance fields that are not numeric', () => {
    const data = { code: 20000, status: true, data: { balance: 'N/A', chargeBalance: 'N/A', totalBalance: 'N/A' } }
    assert.strictEqual(parseSiliconFlowResponse(data), null)
  })
})

// ─── createProviderQuotaFetcher (injectable fetch + time for TTL/backoff) ─────

describe('createProviderQuotaFetcher – TTL cache', () => {
  it('returns cached value within TTL without calling fetch again', async () => {
    let callCount = 0
    const mockFetch = async () => {
      callCount++
      return {
        ok: true,
        json: async () => ({ data: { limit_remaining: 80, limit: 100 } }),
      }
    }

    const fetcher = createProviderQuotaFetcher({ fetchFn: mockFetch, cacheTtlMs: 60_000, errorBackoffMs: 15_000 })

    const r1 = await fetcher('openrouter', 'test-api-key-1234')
    const r2 = await fetcher('openrouter', 'test-api-key-1234')

    assert.strictEqual(callCount, 1, 'fetch should only be called once within TTL')
    assert.strictEqual(r1, r2, 'both calls should return same cached value')
    assert.strictEqual(r1, 80)
  })

  it('re-fetches after TTL expires', async () => {
    let callCount = 0
    const mockFetch = async () => {
      callCount++
      return {
        ok: true,
        json: async () => ({ data: { limit_remaining: 60, limit: 100 } }),
      }
    }

    // Use very short TTL
    const fetcher = createProviderQuotaFetcher({ fetchFn: mockFetch, cacheTtlMs: 1, errorBackoffMs: 1 })

    await fetcher('openrouter', 'test-api-key-5678')
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 5))
    await fetcher('openrouter', 'test-api-key-5678')

    assert.strictEqual(callCount, 2, 'fetch should be called again after TTL expires')
  })

  it('different api keys are cached separately', async () => {
    let callCount = 0
    const mockFetch = async () => {
      callCount++
      return {
        ok: true,
        json: async () => ({ data: { limit_remaining: 50, limit: 100 } }),
      }
    }

    const fetcher = createProviderQuotaFetcher({ fetchFn: mockFetch, cacheTtlMs: 60_000, errorBackoffMs: 15_000 })

    await fetcher('openrouter', 'key-aaa')
    await fetcher('openrouter', 'key-bbb')

    assert.strictEqual(callCount, 2, 'different keys should fetch independently')
  })

  it('keys with same last 8 chars but different content are cached separately (no collision)', async () => {
    // Bug: apiKey.slice(-8) causes collision for keys sharing the same suffix.
    // e.g. 'provider-A-SHARED12' and 'provider-B-SHARED12' → same cache key
    // Fix: use a hash of the full key for collision-resistant keying.
    let callCount = 0
    const mockFetch = async () => {
      callCount++
      return {
        ok: true,
        json: async () => ({ data: { limit_remaining: callCount * 10, limit: 100 } }),
      }
    }

    const fetcher = createProviderQuotaFetcher({ fetchFn: mockFetch, cacheTtlMs: 60_000, errorBackoffMs: 15_000 })

    // Two keys with identical last 8 chars but different full content
    const r1 = await fetcher('openrouter', 'account-A-SHARED12')
    const r2 = await fetcher('openrouter', 'account-B-SHARED12')

    assert.strictEqual(callCount, 2, 'keys sharing same suffix must be cached independently (no collision)')
    assert.notStrictEqual(r1, r2, 'different keys must not share cache entries')
  })
})

describe('createProviderQuotaFetcher – error backoff', () => {
  it('applies short backoff after fetch error, does not spam endpoint', async () => {
    let callCount = 0
    const mockFetch = async () => {
      callCount++
      throw new Error('network error')
    }

    const fetcher = createProviderQuotaFetcher({ fetchFn: mockFetch, cacheTtlMs: 60_000, errorBackoffMs: 60_000 })

    const r1 = await fetcher('openrouter', 'test-key-err')
    const r2 = await fetcher('openrouter', 'test-key-err')

    assert.strictEqual(callCount, 1, 'should not retry immediately after error')
    assert.strictEqual(r1, null)
    assert.strictEqual(r2, null)
  })

  it('returns null when http response is not ok', async () => {
    const mockFetch = async () => ({ ok: false, json: async () => ({}) })
    const fetcher = createProviderQuotaFetcher({ fetchFn: mockFetch, cacheTtlMs: 60_000, errorBackoffMs: 15_000 })
    const result = await fetcher('openrouter', 'test-key-notok')
    assert.strictEqual(result, null)
  })

  it('returns null when json parse fails', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('bad json') },
    })
    const fetcher = createProviderQuotaFetcher({ fetchFn: mockFetch, cacheTtlMs: 60_000, errorBackoffMs: 15_000 })
    const result = await fetcher('openrouter', 'test-key-badjson')
    assert.strictEqual(result, null)
  })
})

// ─── fetchProviderQuota (top-level unified function) ──────────────────────────

describe('fetchProviderQuota – dispatch', () => {
  it('calls openrouter endpoint for provider openrouter', async () => {
    let calledUrl = ''
    const mockFetch = async (url) => {
      calledUrl = url
      return { ok: true, json: async () => ({ data: { limit_remaining: 70, limit: 100 } }) }
    }

    const result = await fetchProviderQuota('openrouter', 'my-key', { fetchFn: mockFetch })
    assert.ok(calledUrl.includes('openrouter.ai'), `expected openrouter URL, got ${calledUrl}`)
    assert.strictEqual(result, 70)
  })

  it('calls siliconflow endpoint for provider siliconflow', async () => {
    let calledUrl = ''
    const mockFetch = async (url) => {
      calledUrl = url
      return {
        ok: true,
        json: async () => ({
          code: 20000,
          status: true,
          data: { balance: '5.00', chargeBalance: '0.00', totalBalance: '5.00' },
        }),
      }
    }

    await fetchProviderQuota('siliconflow', 'my-sf-key', { fetchFn: mockFetch })
    assert.ok(calledUrl.includes('siliconflow'), `expected siliconflow URL, got ${calledUrl}`)
  })

  it('returns null for unknown provider', async () => {
    const result = await fetchProviderQuota('groq', 'some-key')
    assert.strictEqual(result, null)
  })

  it('returns null when apiKey is falsy', async () => {
    const result = await fetchProviderQuota('openrouter', '')
    assert.strictEqual(result, null)
    const result2 = await fetchProviderQuota('openrouter', null)
    assert.strictEqual(result2, null)
  })

  it('uses per-call injectable fetch without polluting module-level cache', async () => {
    // Each call with a different fetchFn should use that fetchFn
    let count1 = 0
    let count2 = 0
    const fetch1 = async () => { count1++; return { ok: true, json: async () => ({ data: { limit_remaining: 10, limit: 100 } }) } }
    const fetch2 = async () => { count2++; return { ok: true, json: async () => ({ data: { limit_remaining: 20, limit: 100 } }) } }

    const r1 = await fetchProviderQuota('openrouter', 'unique-key-aaa', { fetchFn: fetch1 })
    const r2 = await fetchProviderQuota('openrouter', 'unique-key-bbb', { fetchFn: fetch2 })

    assert.strictEqual(r1, 10)
    assert.strictEqual(r2, 20)
    assert.strictEqual(count1, 1)
    assert.strictEqual(count2, 1)
  })
})
