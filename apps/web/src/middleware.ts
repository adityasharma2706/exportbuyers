/**
 * M04 — locale routing middleware (REQ-058). Resolves the locale for page routes and rewrites
 * unprefixed URLs to the default locale. API, RPC, Next internals and static files are skipped so
 * they never pay for an extra redirect.
 */
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing.js';

export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|rpc|_next|_vercel|.*\\..*).*)'],
};
