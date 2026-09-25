/**
 * M01 Platform foundation — public API. Other modules import ONLY from this file.
 *
 * IF-01a ScopedDataAccess : scoped(ctx), systemDb(reason), TenantTable registry
 * IF-01b Cost metrics     : recordCost(...), cost reports, vendor budgets
 * IF-01c Observability    : log, withSpan(...)
 */
export type { ActorContext, ActorKind, ActorRole, AppEnv, Entitlements, Id } from './types.js';
export { AppError, ERROR_HTTP_STATUS, isAppError, rateLimited, toAppError } from './errors.js';
export type { ErrorCode, ErrorResponseBody } from './errors.js';
export { isUuid, newId, uuidv7 } from './ids.js';
export { INDIA_REGIONS, PRIMARY_REGION, assertIndiaRegion, getConfig, initConfig, isIndiaRegion, loadConfig } from './config.js';
export type { PlatformConfig } from './config.js';
export { getSecret, hasSecret, loadSecrets, setSecretsForTesting } from './secrets.js';
export type { SecretName, SecretsSource } from './secrets.js';
export { currentCorrelationId, currentLogContext, log, withLogContext, withSpan } from './logging.js';
export { initTelemetry, shutdownTelemetry } from './telemetry.js';
export { registerTenantTable, registeredTenantTables, tenantScopeOf } from './tenancy.js';
export type { Row, TenantScope, TenantTable, TenantTableRows } from './tenancy.js';
export { assertDbHostInIndia, closeDb, initDb, scoped, systemDb } from './db.js';
export type { Db, InitDbOptions, ScopedDb } from './db.js';
export { closeRedis, getRedis, initRedis } from './redis.js';
export type { RedisLike } from './redis.js';
export { initObjectStore, objectStore } from './storage.js';
export type { ObjectStore, PutResult } from './storage.js';
export { costReport, flushCosts, monthToDateSpend, pendingCostEvents, recordCost, stopCostRecorder } from './cost.js';
export type { CostEventInput, CostGroupBy, CostReportRow } from './cost.js';
export {
  BUDGET_EXCEEDED_PREFIX,
  assertVendorBudget,
  classifyBudget,
  isBudgetExceeded,
  runBudgetCheck,
  setBudgetAlertSink,
} from './budget.js';
export type { BudgetAlert, BudgetAlertSink, BudgetLevel, BudgetStatus } from './budget.js';
export { bootPlatform, shutdownPlatform } from './boot.js';
