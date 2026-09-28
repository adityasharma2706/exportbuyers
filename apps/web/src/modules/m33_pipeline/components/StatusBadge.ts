/**
 * M33 — <StatusBadge status /> (IF-33a UI): a small coloured pill for a shortlist entry's
 * pipeline status, reused by the workspace shortlist view and the "My buyers" cross-workspace
 * view.
 */
import { createElement as h, type ReactNode } from 'react';
import { Pill, type PillTone } from '../../m04_ui/index.js';
import { statusLabel } from '../labels.js';
import type { ShortlistStatus } from '../types.js';

const TONES: Record<ShortlistStatus, PillTone> = {
  to_contact: 'neutral',
  contacted: 'caution',
  replied: 'caution',
  in_discussion: 'caution',
  sample_sent: 'caution',
  order_won: 'positive',
  not_interested: 'neutral',
};

export interface StatusBadgeProps {
  status: ShortlistStatus;
  locale?: 'en' | 'hi';
  className?: string;
}

export function StatusBadge(props: StatusBadgeProps): ReactNode {
  const { status, locale = 'en', className } = props;
  return h(Pill, { tone: TONES[status], className }, statusLabel(status, locale));
}
