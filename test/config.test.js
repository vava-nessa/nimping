import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiKeys, normalizeApiKeyConfig, addApiKey, removeApiKey, listApiKeys } from '../src/core/config.js'

describe('resolveApiKeys', () => {
  it('returns single key as array', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), ['gsk_abc'])
  })

  it('returns array as-is', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), ['gsk_abc', 'gsk_def'])
  })

  it('returns empty array when no key', () => {
    const config = { apiKeys: {} }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), [])
  })

  it('resolves env var fallback', () => {
    process.env.TEST_FCM_KEY_XYZ = 'from-env'
    const config = { apiKeys: {} }
    const keys = resolveApiKeys(config, 'groq', 'TEST_FCM_KEY_XYZ')
    assert.deepStrictEqual(keys, ['from-env'])
    delete process.env.TEST_FCM_KEY_XYZ
  })

  it('filters empty strings', () => {
    const config = { apiKeys: { groq: ['gsk_abc', '', 'gsk_def'] } }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), ['gsk_abc', 'gsk_def'])
  })
})

describe('normalizeApiKeyConfig', () => {
  it('does not convert single key to array on disk', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    normalizeApiKeyConfig(config)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc')
  })

  it('collapses single-element array to string', () => {
    const config = { apiKeys: { groq: ['gsk_abc'] } }
    normalizeApiKeyConfig(config)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc')
  })

  it('keeps array when multiple keys', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    normalizeApiKeyConfig(config)
    assert.deepStrictEqual(config.apiKeys.groq, ['gsk_abc', 'gsk_def'])
  })
})

describe('addApiKey', () => {
  it('adds first key as string', () => {
    const config = { apiKeys: {} }
    const added = addApiKey(config, 'groq', 'gsk_abc')
    assert.strictEqual(added, true)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc')
  })

  it('adding second key converts string to array', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    const added = addApiKey(config, 'groq', 'gsk_def')
    assert.strictEqual(added, true)
    assert.deepStrictEqual(config.apiKeys.groq, ['gsk_abc', 'gsk_def'])
  })

  it('adding third key appends to array', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    addApiKey(config, 'groq', 'gsk_xyz')
    assert.deepStrictEqual(config.apiKeys.groq, ['gsk_abc', 'gsk_def', 'gsk_xyz'])
  })

  it('adding duplicate does not duplicate', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    const added = addApiKey(config, 'groq', 'gsk_abc')
    assert.strictEqual(added, false)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc') // still string, not array
  })

  it('adding duplicate in array does not duplicate', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    const added = addApiKey(config, 'groq', 'gsk_def')
    assert.strictEqual(added, false)
    assert.deepStrictEqual(config.apiKeys.groq, ['gsk_abc', 'gsk_def'])
  })

  it('ignores empty string', () => {
    const config = { apiKeys: {} }
    const added = addApiKey(config, 'groq', '')
    assert.strictEqual(added, false)
    assert.strictEqual(config.apiKeys.groq, undefined)
  })

  it('ignores whitespace-only string', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    const added = addApiKey(config, 'groq', '   ')
    assert.strictEqual(added, false)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc')
  })

  it('trims whitespace from key before adding', () => {
    const config = { apiKeys: {} }
    addApiKey(config, 'groq', '  gsk_abc  ')
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc')
  })
})

describe('removeApiKey', () => {
  it('removes the only string key → deletes provider entry', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    const removed = removeApiKey(config, 'groq')
    assert.strictEqual(removed, true)
    assert.strictEqual(config.apiKeys.groq, undefined)
  })

  it('removing from array-of-2 leaves string when one left', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    const removed = removeApiKey(config, 'groq')
    assert.strictEqual(removed, true)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc') // last removed, first remains as string
  })

  it('removing last key from array-of-1 deletes provider entry', () => {
    const config = { apiKeys: { groq: ['gsk_abc'] } }
    const removed = removeApiKey(config, 'groq')
    assert.strictEqual(removed, true)
    assert.strictEqual(config.apiKeys.groq, undefined)
  })

  it('removing by specific index', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def', 'gsk_xyz'] } }
    const removed = removeApiKey(config, 'groq', 1)
    assert.strictEqual(removed, true)
    assert.deepStrictEqual(config.apiKeys.groq, ['gsk_abc', 'gsk_xyz'])
  })

  it('removing index 0 from array-of-2 leaves last as string', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    removeApiKey(config, 'groq', 0)
    assert.strictEqual(config.apiKeys.groq, 'gsk_def')
  })

  it('returns false when provider has no key', () => {
    const config = { apiKeys: {} }
    const removed = removeApiKey(config, 'groq')
    assert.strictEqual(removed, false)
  })
})

describe('listApiKeys', () => {
  it('returns empty array when no key', () => {
    const config = { apiKeys: {} }
    assert.deepStrictEqual(listApiKeys(config, 'groq'), [])
  })

  it('returns single key as array', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    assert.deepStrictEqual(listApiKeys(config, 'groq'), ['gsk_abc'])
  })

  it('returns array as-is', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    assert.deepStrictEqual(listApiKeys(config, 'groq'), ['gsk_abc', 'gsk_def'])
  })
})
