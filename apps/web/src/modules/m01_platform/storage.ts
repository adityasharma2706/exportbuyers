/**
 * M01 — versioned object storage (S3 in the India region).
 *
 * The bucket has versioning enabled (see infra/terraform). Every write returns the S3
 * versionId so callers can pin exact artefact versions (exports, snapshots).
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assertIndiaRegion, type PlatformConfig } from './config.js';
import { AppError } from './errors.js';

export interface PutResult {
  key: string;
  versionId: string | null;
  etag: string | null;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array | string, contentType: string, metadata?: Record<string, string>): Promise<PutResult>;
  get(key: string, versionId?: string): Promise<{ body: Uint8Array; contentType: string | null; versionId: string | null }>;
}

const KEY_RE = /^[A-Za-z0-9!_.*'()\-/]{1,1024}$/;

function checkKey(key: string): void {
  if (!KEY_RE.test(key) || key.startsWith('/') || key.includes('..')) {
    throw new AppError('VALIDATION', `Invalid object key "${key}"`);
  }
}

class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.s3 = new S3Client({ region: assertIndiaRegion(region, 'object storage') });
  }

  async put(key: string, body: Uint8Array | string, contentType: string, metadata?: Record<string, string>): Promise<PutResult> {
    checkKey(key);
    try {
      const out = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          Metadata: metadata,
          ServerSideEncryption: 'aws:kms',
        }),
      );
      return { key, versionId: (out.VersionId as string | undefined) ?? null, etag: (out.ETag as string | undefined) ?? null };
    } catch (e) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Object storage write failed', { key }, { cause: e });
    }
  }

  async get(key: string, versionId?: string): Promise<{ body: Uint8Array; contentType: string | null; versionId: string | null }> {
    checkKey(key);
    let out: {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
      ContentType?: string;
      VersionId?: string;
    };
    try {
      out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }));
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NoSuchKey' || name === 'NoSuchVersion' || name === 'NotFound') {
        throw new AppError('NOT_FOUND', 'Object not found', { key });
      }
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Object storage read failed', { key }, { cause: e });
    }
    if (!out.Body) throw new AppError('NOT_FOUND', 'Object has no body', { key });
    const bytes: Uint8Array = await out.Body.transformToByteArray();
    return { body: bytes, contentType: (out.ContentType as string | undefined) ?? null, versionId: (out.VersionId as string | undefined) ?? null };
  }
}

let store: ObjectStore | undefined;

export function initObjectStore(cfg: PlatformConfig, override?: ObjectStore): ObjectStore {
  store = override ?? new S3ObjectStore(cfg.objectBucket, cfg.region);
  return store;
}

export function objectStore(): ObjectStore {
  if (!store) throw new AppError('INTERNAL', 'Object store not initialised; call initObjectStore() at boot');
  return store;
}
