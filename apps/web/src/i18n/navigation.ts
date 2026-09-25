/**
 * M04 — locale-aware navigation primitives. Every internal link in the app goes through these so
 * the active locale prefix is preserved when Hindi is added (M51).
 */
import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing.js';

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
