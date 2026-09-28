/**
 * M37 unit tests: front matter parsing, the Markdown renderer, price-token resolution against the
 * real M28 catalogue, the real content tree (loader + service), and the two build checks (hardcoded
 * price lint, review-before-prod gate). Only framework-free modules are imported so this runs
 * under node:test, same as M04's ui.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setCatalogueForTesting, type PriceCatalogue } from '../m28_credits/index.js';
import { splitFrontMatter, validateFrontMatter } from './frontmatter.js';
import { escapeHtml, plainTextExcerpt, renderMarkdown } from './markdown.js';
import { findPriceTokens, resolvePriceTokens, stripPriceTokens } from './priceTokens.js';
import { lintAllForHardcodedPrices, lintDocumentForHardcodedPrices, findReviewGaps, assertReviewedForProd } from './buildcheck.js';
import { allDocuments, getContentIndex, reloadContentForTesting } from './loader.js';
import { byHsChapter, getPage, glossaryTerms, grievanceContact, listBySection, string as contentString } from './service.js';
import type { ContentSourceDocument } from './types.js';

// --------------------------------------------------------------------------------------------
// Front matter
// --------------------------------------------------------------------------------------------

test('splitFrontMatter separates the YAML block from the body', () => {
  const raw = '---\ntitle: "Hello"\nkey: "x.y"\nversion: "1"\n---\n\nBody text here.\n';
  const { data, body } = splitFrontMatter(raw, 'test.md');
  assert.equal((data as { title: string }).title, 'Hello');
  assert.equal(body.trim(), 'Body text here.');
});

test('validateFrontMatter requires title/key/version and validates hsChapters', () => {
  const fm = validateFrontMatter({ title: 'T', key: 'k', version: '1', hsChapters: ['61', '62'] }, 'test.md');
  assert.deepEqual(fm.hsChapters, ['61', '62']);
  assert.throws(() => validateFrontMatter({ key: 'k', version: '1' }, 'test.md'));
  assert.throws(() => validateFrontMatter({ title: 'T', key: 'k', version: '1', hsChapters: ['6'] }, 'test.md'));
});

// --------------------------------------------------------------------------------------------
// Markdown renderer
// --------------------------------------------------------------------------------------------

test('renderMarkdown handles headings, lists, bold/italic, code and safe links', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n[a link](https://example.com)');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>a link<\/a>/);
});

test('renderMarkdown renders GFM-style task list items as disabled checkboxes', () => {
  const html = renderMarkdown('- [ ] Register your IEC\n- [x] Pick an HS code');
  assert.match(html, /<input type="checkbox" disabled \/> Register your IEC/);
  assert.match(html, /<input type="checkbox" disabled checked \/> Pick an HS code/);
});

test('renderMarkdown escapes raw HTML and rejects unsafe link schemes', () => {
  const html = renderMarkdown('<script>alert(1)</script> and [bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:/);
});

test('escapeHtml escapes the five special characters', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('plainTextExcerpt strips tags and truncates', () => {
  const html = '<h1>Title</h1><p>' + 'word '.repeat(100) + '</p>';
  const excerpt = plainTextExcerpt(html, 50);
  assert.ok(excerpt.length <= 51);
  assert.doesNotMatch(excerpt, /<[^>]+>/);
});

// --------------------------------------------------------------------------------------------
// Price tokens (against a fixed test catalogue, not the real config file)
// --------------------------------------------------------------------------------------------

const TEST_CATALOGUE: PriceCatalogue = {
  version: 'test-1',
  effectiveFrom: '2026-01-01',
  inrPerCredit: 10,
  actions: { reveal: 1, reveal_bulk_each: 1, check_buyer: 1, export_row: 0 },
  countryMultipliers: { DE: 1.5 },
};

test('findPriceTokens parses action/quantity/country', () => {
  const tokens = findPriceTokens('{{price:reveal}} and {{price:reveal_bulk_each:5}} and {{price:reveal:1:DE}}');
  assert.equal(tokens.length, 3);
  assert.deepEqual(tokens[0], { raw: '{{price:reveal}}', action: 'reveal', quantity: 1, country: null });
  assert.equal(tokens[1]!.quantity, 5);
  assert.equal(tokens[2]!.country, 'DE');
});

test('resolvePriceTokens renders credits and the rupee hint from the catalogue', () => {
  setCatalogueForTesting(TEST_CATALOGUE);
  try {
    assert.equal(resolvePriceTokens('Cost: {{price:reveal}}.'), 'Cost: 1 credit (₹10).');
    assert.equal(resolvePriceTokens('Cost: {{price:reveal_bulk_each:5}}.'), 'Cost: 5 credits (₹50).');
    assert.equal(resolvePriceTokens('Cost: {{price:export_row}}.'), 'Cost: free.');
    assert.equal(resolvePriceTokens('Cost: {{price:not_a_real_action}}.'), 'Cost: price unavailable.');
  } finally {
    setCatalogueForTesting(undefined);
  }
});

test('stripPriceTokens removes tokens so their digits do not trip the price lint', () => {
  assert.equal(stripPriceTokens('Costs {{price:reveal_bulk_each:5}} credits.'), 'Costs   credits.');
});

// --------------------------------------------------------------------------------------------
// Build checks (fixture-based, independent of the real content tree's review state)
// --------------------------------------------------------------------------------------------

function fixtureDoc(section: ContentSourceDocument['section'], rawBody: string): Pick<ContentSourceDocument, 'locale' | 'section' | 'slug' | 'rawBody'> {
  return { locale: 'en', section, slug: 'fixture', rawBody };
}

test('lintDocumentForHardcodedPrices flags a literal rupee sign, credit number or currency word', () => {
  assert.deepEqual(lintDocumentForHardcodedPrices(fixtureDoc('promise', 'Costs ₹10.')).map((v) => v.reason), ['rupee_literal']);
  assert.deepEqual(lintDocumentForHardcodedPrices(fixtureDoc('pricing', 'Costs 3 credits.')).map((v) => v.reason), ['credit_number_literal']);
  assert.deepEqual(lintDocumentForHardcodedPrices(fixtureDoc('refund-policy', 'Costs Rs 10.')).map((v) => v.reason), ['currency_word_literal']);
  assert.deepEqual(lintDocumentForHardcodedPrices(fixtureDoc('promise', 'Costs {{price:reveal_bulk_each:5}}.')), []);
});

test('lintDocumentForHardcodedPrices only applies to price-sensitive sections', () => {
  assert.deepEqual(lintDocumentForHardcodedPrices(fixtureDoc('learn', 'This costs 3 credits.')), []);
});

test('findReviewGaps flags promise/coverage/refund-policy pages missing reviewedBy/reviewedAt', () => {
  const reviewed = { title: 'T', key: 'k', version: '1', reviewedBy: 'Legal', reviewedAt: '2026-01-01' };
  const unreviewed = { title: 'T', key: 'k', version: '1' };
  const gaps = findReviewGaps([
    { locale: 'en', section: 'promise', slug: 'index', frontMatter: unreviewed },
    { locale: 'en', section: 'coverage', slug: 'index', frontMatter: reviewed },
    { locale: 'en', section: 'learn', slug: 'moq', frontMatter: unreviewed },
  ]);
  assert.equal(gaps.length, 2);
  assert.ok(gaps.every((g) => g.section === 'promise'));
});

test('assertReviewedForProd throws outside production and degrades in production', () => {
  const docs = [{ locale: 'en', section: 'promise' as const, slug: 'index', frontMatter: { title: 'T', key: 'k', version: '1' } }];
  assert.throws(() => assertReviewedForProd(docs, 'test'));
  assert.deepEqual(assertReviewedForProd(docs, 'production').length, 1);
});

// --------------------------------------------------------------------------------------------
// The real content tree (loader + service, IF-37a)
// --------------------------------------------------------------------------------------------

test('the real content tree loads and every page renders without an exception', () => {
  reloadContentForTesting();
  const index = getContentIndex();
  assert.ok(index.root, 'content root should be found from the repo checkout');
  assert.ok(index.locales.includes('en'));
  const docs = allDocuments(index);
  assert.ok(docs.length > 20, `expected a substantial content tree, got ${docs.length} documents`);
});

test('getPage resolves both the section shorthand and section/leaf paths', () => {
  const promise = getPage('en', 'promise');
  assert.ok(promise);
  assert.equal(promise!.section, 'promise');
  assert.match(promise!.html, /<h2>/);

  const incoterms = getPage('en', 'learn/incoterms');
  assert.ok(incoterms);
  assert.equal(incoterms!.slug, 'incoterms');

  assert.equal(getPage('en', 'learn/does-not-exist'), null);
});

test('listBySection returns every Learn article, sorted by title', () => {
  const items = listBySection('en', 'learn');
  assert.ok(items.length >= 14);
  const titles = items.map((i) => i.title);
  assert.deepEqual([...titles].sort((a, b) => a.localeCompare(b)), titles);
});

test('byHsChapter maps a textiles chapter to the sector guide, and validates its input', () => {
  const items = byHsChapter('en', '61');
  assert.ok(items.some((i) => i.slug === 'textiles-and-apparel'));
  assert.throws(() => byHsChapter('en', '6'));
});

test('every one of M32s seven scam guide slugs resolves to a real page', () => {
  const slugs = [
    'advance-fee-scams',
    'certification-fee-scams',
    'freemail-contacts',
    'new-domains',
    'name-domain-mismatch',
    'urgent-large-orders',
    'sample-only-requests',
  ];
  for (const slug of slugs) {
    const page = getPage('en', `scam-red-flags/${slug}`);
    assert.ok(page, `expected a page for guideSlug "${slug}"`);
  }
});

test('string() reads merged strings/*.json content and formats params', () => {
  assert.equal(contentString('en', 'glossary.moq.term'), 'MOQ (Minimum Order Quantity)');
  assert.throws(() => contentString('en', 'no.such.key', undefined, 'test'));
  assert.equal(contentString('en', 'no.such.key', undefined, 'production'), 'no.such.key');
});

test('glossaryTerms returns the six REQ-059 terms in the canonical order', () => {
  const terms = glossaryTerms('en');
  assert.deepEqual(
    terms.map((t) => t.id),
    ['hs_itc_hs', 'iec', 'incoterms', 'fob', 'cif', 'moq'],
  );
  assert.ok(terms.every((t) => t.term.length > 0 && t.short.length > 0));
});

test('grievanceContact reads the DPDP contact fields for M38', () => {
  const contact = grievanceContact('en');
  assert.ok(contact);
  assert.match(contact!.email, /@/);
});

// --------------------------------------------------------------------------------------------
// LLD rule: "A build check fails on any hardcoded ₹ or credit number inside the promise, refund
// and pricing pages." Runs over the real content tree, so a future edit that slips a literal
// price into promise/refund-policy/pricing fails this test.
// --------------------------------------------------------------------------------------------

test('the real promise/refund-policy/pricing pages contain no hardcoded prices', () => {
  const violations = lintAllForHardcodedPrices(allDocuments());
  assert.deepEqual(violations, []);
});
