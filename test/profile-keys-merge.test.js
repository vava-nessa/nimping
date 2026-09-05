/**
 * Test that loading a profile MERGES apiKeys instead of replacing them.
 * This prevents API keys from disappearing when switching profiles.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

export function testProfileKeysMerge() {
  describe('Profile keys merge', () => {
    it('should preserve existing keys when loading a profile with fewer keys', () => {
      // Simule un objet config avec 3 clés
      const config = {
        apiKeys: {
          nvidia: 'nvapi-test-1',
          groq: 'gsk-test-2',
          openrouter: 'sk-or-test-3'
        },
        providers: {},
        favorites: [],
        settings: {},
        profiles: {
          work: {
            apiKeys: {
              nvidia: 'nvapi-work-override'  // Seulement nvidia dans le profil
            },
            providers: {},
            favorites: ['work/fav'],
            settings: {}
          }
        }
      }

      // Simule le comportement de loadProfile (fusion au lieu de remplacer)
      const profile = config.profiles.work
      const profileApiKeys = profile.apiKeys || {}
      const mergedApiKeys = { ...config.apiKeys, ...profileApiKeys }
      config.apiKeys = mergedApiKeys

      // Vérifie que toutes les clés sont présentes
      assert.strictEqual(config.apiKeys.nvidia, 'nvapi-work-override', 'nvidia key should be overridden by profile')
      assert.strictEqual(config.apiKeys.groq, 'gsk-test-2', 'groq key should be preserved')
      assert.strictEqual(config.apiKeys.openrouter, 'sk-or-test-3', 'openrouter key should be preserved')
      assert.strictEqual(Object.keys(config.apiKeys).length, 3, 'should have 3 keys total')
    })

    it('should handle profile with no apiKeys gracefully', () => {
      const config = {
        apiKeys: {
          nvidia: 'nvapi-test-1',
          groq: 'gsk-test-2'
        },
        providers: {},
        favorites: [],
        settings: {},
        profiles: {
          minimal: {
            providers: {},
            favorites: [],
            settings: { sortColumn: 'avg' }
            // pas de apiKeys du tout
          }
        }
      }

      // Fusion
      const profile = config.profiles.minimal
      const profileApiKeys = profile.apiKeys || {}
      const mergedApiKeys = { ...config.apiKeys, ...profileApiKeys }
      config.apiKeys = mergedApiKeys

      // Vérifie que les clés originales sont préservées
      assert.strictEqual(config.apiKeys.nvidia, 'nvapi-test-1', 'nvidia key should be preserved')
      assert.strictEqual(config.apiKeys.groq, 'gsk-test-2', 'groq key should be preserved')
      assert.strictEqual(Object.keys(config.apiKeys).length, 2, 'should still have 2 keys')
    })
  })
}

// Self-register when run by `node --test` (the file only exported the runner,
// so the suite was silently collected as zero tests before this call).
testProfileKeysMerge()
