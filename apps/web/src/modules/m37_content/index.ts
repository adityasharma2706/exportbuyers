/**
 * M37 Content, Learn and promise pages — public API (IF-37a). Other modules import ONLY from this
 * file.
 *
 * getPage(locale, slug); listBySection(locale, section); byHsChapter(locale, chapter);
 * string(locale, key, params?)
 *
 * REQ-059 Learn area + in-context tooltip glossary (HS/ITC-HS, IEC, Incoterms, FOB/CIF, MOQ).
 * REQ-031 (Learn part) scam red-flag guides referenced by M32's RedFlag.guideSlug.
 * REQ-044 first-export checklist + outreach guidance (first email, sample requests, Incoterms).
 * REQ-065 Learn pages mapped to DGFT Trade Connect / EPCs / missions by HS chapter.
 * REQ-066 public promise / coverage / refund-policy / pricing pages, prices from M28's catalogue.
 */
export {
  CONTENT_SECTIONS,
  PRICE_SENSITIVE_SECTIONS,
  isContentSection,
} from './types.js';
export type {
  ContentApi,
  ContentFrontMatter,
  ContentPageDto,
  ContentPageSummaryDto,
  ContentSection,
  ContentSourceDocument,
  GlossaryTermDto,
  GrievanceContactDto,
} from './types.js';

export { byHsChapter, getPage, glossaryTerms, grievanceContact, listBySection, string, GLOSSARY_TERM_ORDER } from './service.js';

export { getContentIndex, allDocuments, reloadContentForTesting } from './loader.js';
export type { ContentIndex } from './loader.js';

export { renderMarkdown, escapeHtml, plainTextExcerpt } from './markdown.js';
export { findPriceTokens, resolvePriceTokens, stripPriceTokens, PRICE_TOKEN_RE } from './priceTokens.js';
export type { PriceToken } from './priceTokens.js';

export {
  lintAllForHardcodedPrices,
  lintDocumentForHardcodedPrices,
  findReviewGaps,
  assertReviewedForProd,
  UnreviewedContentError,
} from './buildcheck.js';
export type { PriceLintViolation, ReviewGapViolation } from './buildcheck.js';

export { CONTENT_NAMESPACE, CONTENT_MESSAGES_EN, resolveContentLabels, fillLabel } from './labels.js';
export type { ContentLabelKey, ContentLabels } from './labels.js';

export { registerContentRoutes } from './routes.js';
export type { ContentRouteApp, ContentRouteReply, ContentRouteRequest } from './routes.js';

export { ContentPage } from './components/ContentPage.js';
export type { ContentBreadcrumbItem, ContentPageProps } from './components/ContentPage.js';
export { ContentList } from './components/ContentList.js';
export type { ContentListProps } from './components/ContentList.js';
