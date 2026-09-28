/**
 * M31 unit tests (LLD M31). Covers the parts that do not need a live Postgres: the token
 * hashing primitives, config validation, the type vocabularies, and that the `removal.request`
 * review type registers cleanly against M11's registry. Run: node --test (after build).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { resetReviewRegistryForTesting } from '../m11_review/index.js';
import { generateToken, sha256Hex } from './crypto.js';
import { loadRemovalConfigFromEnv, removalConfig, resetRemovalConfigForTesting, setRemovalConfig } from './config.js';
import { registerRemovalReviewType, resetRemovalReviewTypeForTesting, REMOVAL_REQUEST_TYPE } from './reviewTypes.js';
import { IDENTITY_CHECKS, REMOVAL_KINDS, REMOVAL_OUTCOMES } from './types.js';

describe('m31 crypto', () => {
  test('generateToken returns distinct, URL-safe tokens', () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{40,50}$/);
  });

  test('sha256Hex is deterministic and content-sensitive', () => {
    assert.equal(sha256Hex('hello'), sha256Hex('hello'));
    assert.notEqual(sha256Hex('hello'), sha256Hex('Hello'));
    assert.match(sha256Hex('hello'), /^[0-9a-f]{64}$/);
  });
});

describe('m31 config', () => {
  afterEach(() => {
    resetRemovalConfigForTesting();
    delete process.env.M31_PUBLIC_BASE_URL;
    delete process.env.M31_CHALLENGE_TTL_HOURS;
    delete process.env.APP_ENV;
  });

  test('defaults are sane', () => {
    resetRemovalConfigForTesting();
    const cfg = removalConfig();
    assert.equal(cfg.challengeTtlHours, 24);
    assert.equal(cfg.challengeRetentionDays, 30);
  });

  test('rejects a non-positive TTL', () => {
    assert.throws(() => setRemovalConfig({ challengeTtlHours: 0 }), /challengeTtlHours/);
  });

  test('rejects a non-http(s) base URL', () => {
    assert.throws(() => setRemovalConfig({ publicBaseUrl: 'ftp://example.com' }), /publicBaseUrl/);
  });

  test('strips a trailing slash from the base URL', () => {
    const cfg = setRemovalConfig({ publicBaseUrl: 'https://app.example.in/' });
    assert.equal(cfg.publicBaseUrl, 'https://app.example.in');
  });

  test('loadRemovalConfigFromEnv reads overrides', () => {
    const cfg = loadRemovalConfigFromEnv({
      APP_ENV: 'local',
      M31_PUBLIC_BASE_URL: 'https://removal.example.in',
      M31_CHALLENGE_TTL_HOURS: '12',
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.publicBaseUrl, 'https://removal.example.in');
    assert.equal(cfg.challengeTtlHours, 12);
  });

  test('requires M31_PUBLIC_BASE_URL outside local/test', () => {
    assert.throws(() => loadRemovalConfigFromEnv({ APP_ENV: 'production' } as NodeJS.ProcessEnv), /M31_PUBLIC_BASE_URL/);
  });
});

describe('m31 types', () => {
  test('vocabularies match the LLD', () => {
    assert.deepEqual([...REMOVAL_KINDS], ['removal', 'correction']);
    assert.deepEqual([...IDENTITY_CHECKS], ['ok', 'needs_identity_check']);
    assert.deepEqual([...REMOVAL_OUTCOMES], ['approve_removal', 'approve_correction', 'reject']);
  });
});

describe('m31 review type registration', () => {
  afterEach(() => {
    resetRemovalReviewTypeForTesting();
    resetReviewRegistryForTesting();
  });

  test('registers removal.request against M11 without throwing', () => {
    resetReviewRegistryForTesting();
    assert.doesNotThrow(() => registerRemovalReviewType());
  });

  test('is idempotent: a second call does not re-register (and so does not throw CONFLICT)', () => {
    resetReviewRegistryForTesting();
    registerRemovalReviewType();
    assert.doesNotThrow(() => registerRemovalReviewType());
  });

  test('exports the LLD type name', () => {
    assert.equal(REMOVAL_REQUEST_TYPE, 'removal.request');
  });
});
