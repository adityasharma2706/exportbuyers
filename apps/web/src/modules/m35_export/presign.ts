/**
 * M35 — S3 pre-signed download links and object deletion.
 *
 * [deviation: M01's object store (storage.ts `ObjectStore`) exposes only `put`/`get`, with no
 * pre-signed URL and no delete — neither of which this module can do without (LLD API:
 * "downloadUrl? (S3 pre-signed, 15 min)"; LLD EV-04 handler: "Delete ready files"). This builds
 * its own minimal S3Client for exactly those two operations, the same way storage.ts builds its
 * own (bucket/region read from the same PlatformConfig, region asserted to be in India the same
 * way), rather than widening M01's shared interface for one caller.]
 */
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertIndiaRegion, getConfig } from '../m01_platform/index.js';
import { exportConfig } from './config.js';

let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) client = new S3Client({ region: assertIndiaRegion(getConfig().region, 'm35 export downloads') });
  return client;
}

/** For tests: inject a fake S3Client (or reset to build a fresh real one). */
export function setS3ClientForTesting(c: S3Client | undefined): void {
  client = c;
}

/** LLD IF-35a: `downloadUrl? (S3 pre-signed, 15 min)`. */
export async function presignExportDownload(key: string, expirySeconds = exportConfig().presignExpirySeconds): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: getConfig().objectBucket, Key: key });
  return getSignedUrl(s3(), cmd, { expiresIn: expirySeconds });
}

/** LLD EV-04 handler: "Delete ready files whose source contained a suppressed company." */
export async function deleteExportObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: getConfig().objectBucket, Key: key }));
}
