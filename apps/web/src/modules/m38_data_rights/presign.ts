/**
 * M38 — S3 pre-signed download link for the export zip (LLD Rules: "the download link is
 * pre-signed for 24 h"). Mirrors M35's own presign.ts: M01's ObjectStore (storage.ts) exposes
 * only put/get, no pre-signing, so this builds its own minimal S3Client for exactly that, reading
 * the same bucket/region from PlatformConfig.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertIndiaRegion, getConfig } from '../m01_platform/index.js';
import { dataRightsConfig } from './config.js';

let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) client = new S3Client({ region: assertIndiaRegion(getConfig().region, 'm38 data-rights export downloads') });
  return client;
}

/** For tests: inject a fake S3Client (or reset to build a fresh real one). */
export function setS3ClientForTesting(c: S3Client | undefined): void {
  client = c;
}

export async function presignRightsExportDownload(key: string, expirySeconds = dataRightsConfig().presignExpirySeconds): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: getConfig().objectBucket, Key: key });
  return getSignedUrl(s3(), cmd, { expiresIn: expirySeconds });
}
