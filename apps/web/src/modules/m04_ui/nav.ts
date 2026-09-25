/**
 * M04 — information architecture (design §3.2) as data. The app shell, the home page and any
 * future sitemap all read this one list, so adding an area is a one-line change.
 */
import { stripLocalePrefix } from '../../i18n/locales.js';

export const ROUTES = {
  home: '/',
  products: '/products',
  markets: '/markets',
  buyers: '/buyers',
  myBuyers: '/my-buyers',
  check: '/check',
  learn: '/learn',
  account: '/account',
  signUp: '/sign-up',
  signIn: '/sign-in',
} as const;

export type NavId = 'home' | 'products' | 'markets' | 'buyers' | 'myBuyers' | 'check' | 'learn' | 'account';

export type NavIconName = 'home' | 'box' | 'globe' | 'search' | 'list' | 'shield' | 'book' | 'user';

export interface NavItem {
  id: NavId;
  href: string;
  /** Message key for the label (nav.<id>.label). */
  labelKey: `nav.${NavId}.label`;
  /** Message key for the one-line description (nav.<id>.description). */
  descriptionKey: `nav.${NavId}.description`;
  icon: NavIconName;
  /** Shown in the bottom bar on phones; the rest go under "More". */
  mobilePrimary: boolean;
  /** Anonymous visitors can open it (markets, buyer preview, check, learn are public funnels). */
  publicAccess: boolean;
}

function item(id: NavId, icon: NavIconName, mobilePrimary: boolean, publicAccess: boolean): NavItem {
  return {
    id,
    href: ROUTES[id],
    labelKey: `nav.${id}.label`,
    descriptionKey: `nav.${id}.description`,
    icon,
    mobilePrimary,
    publicAccess,
  };
}

/** Order follows design §3.2 and LLD M04: Home, Products, Markets, Buyers, My buyers, Check a buyer, Learn, Account. */
export const NAV_ITEMS: readonly NavItem[] = [
  item('home', 'home', true, true),
  item('products', 'box', true, false),
  item('markets', 'globe', false, true),
  item('buyers', 'search', true, true),
  item('myBuyers', 'list', true, false),
  item('check', 'shield', false, true),
  item('learn', 'book', false, true),
  item('account', 'user', false, false),
];

/** A mobile bottom bar fits four destinations plus "More" at 360 px wide with 48 px targets. */
export const MAX_MOBILE_PRIMARY = 4;

export function partitionNav(items: readonly NavItem[] = NAV_ITEMS): { primary: NavItem[]; overflow: NavItem[] } {
  const primary: NavItem[] = [];
  const overflow: NavItem[] = [];
  for (const entry of items) {
    if (entry.mobilePrimary && primary.length < MAX_MOBILE_PRIMARY) primary.push(entry);
    else overflow.push(entry);
  }
  return { primary, overflow };
}

/** True when `pathname` (with or without a locale prefix) is inside the item's area. */
export function isNavItemActive(pathname: string, entry: NavItem): boolean {
  const path = stripLocalePrefix(pathname);
  if (entry.href === '/') return path === '/';
  return path === entry.href || path.startsWith(`${entry.href}/`);
}

/** The single active area for a pathname (longest matching href wins), or null. */
export function activeNavId(pathname: string, items: readonly NavItem[] = NAV_ITEMS): NavId | null {
  let best: NavItem | null = null;
  for (const entry of items) {
    if (isNavItemActive(pathname, entry) && (best === null || entry.href.length > best.href.length)) best = entry;
  }
  return best ? best.id : null;
}
