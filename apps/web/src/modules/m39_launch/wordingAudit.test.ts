/**
 * M39 wording-audit tests (LLD M39 #7). Runs the real audit against the live content tree,
 * message catalogues and template label sources — a failing assertion here is the "CI grep"
 * the LLD asks for (see wordingAudit.ts's header comment on why this runs as a test, not a
 * standalone script).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findForbiddenWording, runWordingAudit, scanRegisteredLabelSources } from './wordingAudit.js';

test('findForbiddenWording matches the LLD M39 #7 pattern, case-insensitively', () => {
  const a = 'This is a Verified Genuine buyer.';
  const b = 'A GUARANTEED BUYER awaits.';
  const c = '100% Genuine exporters only';
  assert.deepEqual(findForbiddenWording(a), [a]); // short text: the +/-30 char window covers the whole string
  assert.deepEqual(findForbiddenWording(b), [b]);
  assert.deepEqual(findForbiddenWording(c), [c]);
  assert.deepEqual(findForbiddenWording('We never claim a buyer is genuine or guaranteed.'), []);
});

test('findForbiddenWording finds every match, not just the first', () => {
  const hits = findForbiddenWording('verified genuine here, and again: verified genuine there.');
  assert.equal(hits.length, 2);
});

test('scanRegisteredLabelSources is clean against the real *_MESSAGES_EN exports', () => {
  assert.deepEqual(scanRegisteredLabelSources(), []);
});

test('runWordingAudit() finds no forbidden wording anywhere in /content, /apps/web/messages or the templates', async () => {
  const violations = await runWordingAudit();
  assert.deepEqual(
    violations,
    [],
    `forbidden wording found: ${violations.map((v) => `${v.source}:${v.location} -> "${v.snippet}"`).join('; ')}`,
  );
});
