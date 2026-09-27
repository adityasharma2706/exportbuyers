/**
 * M18 Normalisation and entity resolution — serving-plane public API. Other modules import ONLY
 * from this file. (Normalisation, anchors, fuzzy matching and resolve() live in py/kp/m18_resolution.)
 *
 * M11    review type `entity.merge_review` (outcomes merge | distinct) and the
 *        `m18.file_merge_review` job. `merge` → M09 IF-09b `merge_confirm`; `distinct` →
 *        `merge_reject`. Call registerResolutionModule() at boot (web and worker).
 */
export {
  FILE_MERGE_REVIEW_JOB,
  MERGE_OUTCOMES,
  MERGE_REVIEW_SLA_HOURS,
  MERGE_REVIEW_TYPE,
  fileMergeReview,
  mergeReviewOutcomeSchema,
  mergeReviewPayloadSchema,
  pairKey,
  registerResolutionModule,
  resetResolutionModuleForTesting,
} from './review.js';
export type { MergeOutcome, MergeReviewOutcome, MergeReviewPayload } from './review.js';
