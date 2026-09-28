/**
 * M32 Check a buyer — core service (LLD M32). REQ-030 (the standalone check tool), REQ-031
 * (contextual part: evaluateContextual, wired into M27 by index.ts), REQ-051 (metered by the free
 * allowance, then credits).
 *
 * Deps: M05 (guardAnonymous — enforced by routes.ts before this runs), M24 (the trust rollup, via
 * client.ts's IF-24b RPC client), M28 (quote/hold/commit/release/consumeAllowance/undoAllowance —
 * REQ-051's metering). M10's `matchByIdentifiers` links a matching catalogue entity, per LLD M32:
 * "Inputs are not added to the catalogue unless they resolve to an existing entity."
 */
import { log, newId, withSpan, type ActorContext } from '../m01_platform/index.js';
import { commit, consumeAllowance, hold, quote, release, undoAllowance } from '../m28_credits/index.js';
import { matchByIdentifiers } from '../m10_policy/index.js';
import type { TrustCheckDto, TrustResultDto } from '../m04_ui/index.js';
import { buildAdviceKeys } from './advice.js';
import { evaluateAdhocTrust } from './client.js';
import { checkBuyerConfig } from './config.js';
import { encryptInput } from './crypto.js';
import { evaluateRedFlags } from './rules.js';
import { insertCheckRun } from './repo.js';
import { parseCheckBuyerRequest } from './validate.js';
import type { CheckBuyerRequestDto, CheckBuyerResponseDto, RedFlag, SanctionsResultOrUnknown, TrustAdhocResultDto } from './types.js';

function findCheck(checks: readonly TrustAdhocResultDto['checks'][number][], id: string): TrustAdhocResultDto['checks'][number] | undefined {
  return checks.find((c) => c.id === id);
}

/** LLD M24 sanctions table (pass=clear, fail=hit-or-possible, unknown=screener unavailable),
 * disambiguated from the check's own explanationKey suffix (py checks.py: `.hit` / `.possible`).
 * A `fail` whose reason cannot be read is treated as `possible` — fail-safe (LLD assumption 3). */
export function sanctionsFromChecks(checks: readonly TrustAdhocResultDto['checks'][number][]): SanctionsResultOrUnknown {
  const c = findCheck(checks, 'sanctions');
  if (!c) return 'unknown';
  if (c.outcome === 'pass') return 'clear';
  if (c.outcome === 'unknown') return 'unknown';
  return c.explanationKey.endsWith('.hit') ? 'hit' : 'possible';
}

/** M32 has no domain-age reading of its own; `new_domain` reuses M24's own `domain_age` verdict
 * (see rules.ts's doc comment). */
export function newDomainFromChecks(checks: readonly TrustAdhocResultDto['checks'][number][]): boolean {
  return findCheck(checks, 'domain_age')?.outcome === 'fail';
}

function toTrustResultDto(r: TrustAdhocResultDto): TrustResultDto {
  const checks: TrustCheckDto[] = r.checks.map((c) => ({
    id: c.id,
    outcome: c.outcome,
    checkedAt: c.checkedAt,
    explanationKey: c.explanationKey,
  }));
  return { level: r.level, checks, ruleVersion: r.ruleVersion, copyVersion: r.copyVersion };
}

function domainOrEmail(input: CheckBuyerRequestDto): { domain?: string; email?: string } {
  const out: { domain?: string; email?: string } = {};
  if (input.website) out.domain = input.website;
  if (input.email) out.email = input.email;
  return out;
}

/**
 * IF-32a `POST /api/check`. Metering (LLD M32 rule): the anonymous rate limit
 * (`guardAnonymous('check')`) is the route's job (routes.ts), same split as M26; a signed-in
 * account here consumes its free allowance first, then quotes/holds/commits credits.
 */
export async function checkBuyer(ctx: ActorContext, rawBody: unknown): Promise<CheckBuyerResponseDto> {
  const input = parseCheckBuyerRequest(rawBody);
  const accountId = ctx.kind === 'user' || ctx.kind === 'admin' ? ctx.accountId : undefined;

  return withSpan(
    'm32.checkBuyer',
    async () => {
      let usedAllowance = false;
      let holdId: string | null = null;

      if (accountId) {
        usedAllowance = await consumeAllowance(ctx, checkBuyerConfig().allowanceKind, 1);
        if (!usedAllowance) {
          const q = quote(ctx, checkBuyerConfig().priceAction);
          if (q.credits > 0) {
            const h = await hold(ctx, {
              credits: q.credits,
              actionType: checkBuyerConfig().priceAction,
              idempotencyKey: `check:${accountId}:${newId<'check_run'>()}`,
            });
            holdId = h.holdId;
          }
        }
      }

      const cleanupPayment = async (): Promise<void> => {
        if (holdId) {
          await release(ctx, holdId).catch((err: unknown) => log.error({ err, holdId }, 'm32: failed to release a check hold'));
        } else if (usedAllowance) {
          await undoAllowance(ctx, checkBuyerConfig().allowanceKind, 1).catch((err: unknown) => log.error({ err }, 'm32: failed to undo a check allowance'));
        }
      };

      let adhoc: TrustAdhocResultDto;
      try {
        adhoc = await evaluateAdhocTrust(ctx, {
          ...(input.name ? { name: input.name } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.website ? { website: input.website } : {}),
          ...(input.country ? { country: input.country } : {}),
        });
      } catch (err) {
        await cleanupPayment();
        throw err;
      }

      const sanctions = sanctionsFromChecks(adhoc.checks);
      const redFlags: RedFlag[] = evaluateRedFlags({
        ...(input.name ? { name: input.name } : {}),
        ...(input.email ? { email: input.email } : {}),
        ...(input.website ? { website: input.website } : {}),
        ...(input.messageText ? { messageText: input.messageText } : {}),
        domainSignals: { newDomain: newDomainFromChecks(adhoc.checks) },
      });
      const adviceKeys = buildAdviceKeys(adhoc.level, sanctions, redFlags);

      let matchedCompanyId: string | undefined;
      try {
        const m = await matchByIdentifiers(ctx, domainOrEmail(input));
        if (m) matchedCompanyId = m;
      } catch (err) {
        log.warn({ err }, 'm32: matchByIdentifiers failed; continuing without a catalogue match');
      }

      let creditsCharged = 0;
      if (holdId) {
        const c = await commit(ctx, holdId);
        creditsCharged = c.committed;
      }

      const out: CheckBuyerResponseDto = {
        trust: toTrustResultDto(adhoc),
        sanctions,
        redFlags,
        adviceKeys,
        creditsCharged,
      };
      if (matchedCompanyId) out.matchedCompanyId = matchedCompanyId;

      if (accountId) {
        const checkRunId = newId<'check_run'>();
        const result: Record<string, unknown> = { ...out };
        const plain = JSON.stringify(input);
        await insertCheckRun(ctx, {
          id: checkRunId,
          inputEnc: encryptInput(plain, accountId, checkRunId),
          result,
        }).catch((err: unknown) => log.error({ err }, 'm32: failed to store check_run history (result already returned to the caller)'));
      }

      return out;
    },
    { hasName: !!input.name, hasEmail: !!input.email, hasWebsite: !!input.website },
  );
}
