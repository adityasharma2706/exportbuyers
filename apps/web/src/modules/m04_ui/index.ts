/**
 * M04 Web front-end shell and design system — public API (IF-04a). Other modules import ONLY
 * from this file (LLD §0.1).
 *
 * REQ-057 mobile-first SSR shell + performance budgets; REQ-058 i18n framework with all strings
 * externalised; REQ-054 CostBadge reading prices from the M28 catalogue (IF-28c).
 */

// Locale + routing
export {
  DEFAULT_LOCALE,
  LOCALES,
  TIME_ZONE,
  isLocale,
  localeDirection,
  stripLocalePrefix,
  toIntlLocale,
} from '../../i18n/locales.js';
export type { Locale } from '../../i18n/locales.js';
export { Link, getPathname, redirect, usePathname, useRouter } from '../../i18n/navigation.js';

// Message catalogues
export {
  CLIENT_NAMESPACES,
  diffCatalogues,
  flattenMessages,
  getMessage,
  loadMessages,
  pickMessages,
  argumentsOf,
} from './i18n/messages.js';
export type { CatalogueDiff, Messages } from './i18n/messages.js';

// Information architecture
export { MAX_MOBILE_PRIMARY, NAV_ITEMS, ROUTES, activeNavId, isNavItemActive, partitionNav } from './nav.js';
export type { NavIconName, NavId, NavItem } from './nav.js';

// DTOs + wording rules
export { TRUST_CHECK_IDS } from './dto.js';
export type {
  CoverageCellDto,
  CoverageLabelValue,
  DisclaimerKind,
  TrustCheckDto,
  TrustCheckId,
  TrustLevel,
  TrustOutcome,
  TrustResultDto,
} from './dto.js';
export {
  FORBIDDEN_TRUST_WORDING,
  ForbiddenWordingError,
  containsForbiddenTrustWording,
  guardTrustText,
  orderTrustChecks,
  splitCoverageKey,
  trustCounts,
} from './wording.js';

// Prices (IF-28c client)
export {
  PRICE_ACTIONS,
  PriceUnavailableError,
  computeCost,
  createPriceClient,
  defaultPriceClient,
  isPriceAction,
  parseCatalogue,
  resolveCost,
} from './pricing/prices.js';
export type {
  CostOptions,
  CostQuote,
  CostResolution,
  FetchLike,
  PriceAction,
  PriceCatalogueDto,
  PriceClient,
  PriceClientOptions,
} from './pricing/prices.js';

// Performance budgets
export {
  LIGHTHOUSE_DEVICE_PROFILE,
  PERFORMANCE_BUDGETS,
  evaluateLighthouse,
  evaluateRouteBundles,
  formatBreach,
} from './perf/budgets.js';
export type { BudgetBreach, LighthouseMetrics } from './perf/budgets.js';

// Literal-text check
export { findLiteralChildren } from './lint/literalText.js';
export type { LiteralTextViolation } from './lint/literalText.js';

// Components (IF-04a)
export { Button, Card, Icon, Pill, Skeleton, VisuallyHidden, buttonClasses, cx } from './components/primitives.js';
export type { ButtonProps, ButtonSize, ButtonVariant, CardProps, IconName, IconProps, PillProps, PillTone } from './components/primitives.js';
export { CostBadge, describeCost } from './components/CostBadge.js';
export type { CostBadgeProps, CostText } from './components/CostBadge.js';
export { CoverageLabel, formatSources } from './components/CoverageLabel.js';
export type { CoverageLabelProps } from './components/CoverageLabel.js';
export { TrustChecklist } from './components/TrustChecklist.js';
export type { TrustChecklistProps } from './components/TrustChecklist.js';
export { DISCLAIMER_KINDS, Disclaimer } from './components/Disclaimer.js';
export type { DisclaimerProps } from './components/Disclaimer.js';
export { SignupGate, safeReturnPath, signupHref } from './components/SignupGate.js';
export type { SignupGateProps } from './components/SignupGate.js';
export { NavBar } from './components/NavBar.js';
export type { NavBarProps } from './components/NavBar.js';
export { AppShell, MAIN_CONTENT_ID } from './components/AppShell.js';
export type { AppShellProps } from './components/AppShell.js';
