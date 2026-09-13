/**
 * Where file bytes actually live.
 *
 * Two backends, one interface. `local` writes under a directory; `s3` writes
 * to an object store. The choice is configuration -- `STORAGE_BACKEND` -- and
 * nothing above this module knows which one it got: storage keys are the same
 * strings either way, so the database, the reference syntax and every URL are
 * backend-independent. Switching is a config change plus `admin storage
 * migrate`, never a schema change.
 *
 * Three rules hold whichever backend is in use, and they are the reason this
 * is an interface rather than an `if` at each call site:
 *
 *   1. **A key is validated identically.** Traversal is meaningless against an
 *      object store, but a key that would escape a directory is still a bug,
 *      and a rule enforced in one backend and not the other is the shape that
 *      rots. `assertSafeKey` runs in both.
 *   2. **Bytes are read through the application, never handed out directly.**
 *      There is deliberately no presigned-URL method here. A presigned URL is
 *      a bearer token that outlives the visibility check that minted it and
 *      carries the storage key in plain sight -- both of which invariant 3
 *      rules out. Adding one would move the access decision out of
 *      `findServableFile` and into a URL nobody can revoke.
 *   3. **A write is all-or-nothing.** The local backend writes a temporary
 *      name and renames; S3 makes an object visible only once the PUT
 *      completes. Neither can leave truncated bytes at the address a content
 *      hash promises.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Config } from '../config.js';
import { assertSafeKey, resolveStoragePath } from './storage.js';

export type StorageBackendKind = 'local' | 's3';

/** Raised when a key names nothing. Every caller turns this into a 404. */
export class StorageObjectNotFoundError extends Error {
  public constructor(key: string) {
    super(`No stored object at ${JSON.stringify(key)}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

export interface StorageBackend {
  readonly kind: StorageBackendKind;
  /** A one-line description for the startup log and the preflight report. */
  describe(): string;
  /** Throws when the backend is unreachable or unusable. */
  check(): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** A stream of the object's bytes, or StorageObjectNotFoundError. */
  openRead(key: string): Promise<Readable>;
  put(key: string, contents: Buffer): Promise<void>;
  /** Stores the contents of a local file. The local file is left in place. */
  putFile(key: string, localPath: string, byteSize: number): Promise<void>;
}

// --- Local -----------------------------------------------------------------

class LocalBackend implements StorageBackend {
  public readonly kind = 'local';

  public constructor(private readonly root: string) {}

  public describe(): string {
    return `local directory ${this.root}`;
  }

  public async check(): Promise<void> {
    // Written to rather than merely stat'ed: a read-only bind mount is the
    // failure this is looking for, and it looks identical to a healthy one
    // until something tries to write.
    const probe = resolveStoragePath(this.root, `tmp/${randomUUID()}.probe`);
    await mkdir(dirname(probe), { recursive: true });
    await pipeline(Readable.from(Buffer.alloc(0)), createWriteStream(probe));
    await rm(probe, { force: true });
  }

  public async exists(key: string): Promise<boolean> {
    try {
      await stat(resolveStoragePath(this.root, key));
      return true;
    } catch {
      return false;
    }
  }

  public async openRead(key: string): Promise<Readable> {
    const path = resolveStoragePath(this.root, key);
    try {
      await stat(path);
    } catch {
      throw new StorageObjectNotFoundError(key);
    }
    return createReadStream(path);
  }

  public async put(key: string, contents: Buffer): Promise<void> {
    await this.write(key, Readable.from(contents));
  }

  public async putFile(key: string, localPath: string): Promise<void> {
    const path = resolveStoragePath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      // Same filesystem: a rename is atomic and copies nothing.
      await rename(localPath, path);
      return;
    } catch {
      // Across filesystems rename fails; fall back to a copy through the
      // same temporary-then-rename dance.
    }
    await this.write(key, createReadStream(localPath));
  }

  /** Temporary name then rename, so a crash cannot leave truncated bytes. */
  private async write(key: string, source: Readable): Promise<void> {
    const path = resolveStoragePath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.partial`;
    try {
      await pipeline(source, createWriteStream(temporary));
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

// --- S3 --------------------------------------------------------------------

class S3Backend implements StorageBackend {
  public readonly kind = 's3';
  private readonly client: S3Client;

  public constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    client: S3Client,
  ) {
    this.client = client;
  }

  public describe(): string {
    return `s3 bucket ${this.bucket}${this.prefix === '' ? '' : ` under ${this.prefix}`}`;
  }

  public async check(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /**
   * The object name for a storage key.
   *
   * Validated with the same rule the local backend uses. A `..` cannot escape
   * a bucket, but it would still address an object nothing else can name, and
   * one rule enforced in one place is the arrangement this whole module
   * exists to avoid.
   */
  private objectKey(key: string): string {
    assertSafeKey(key);
    return `${this.prefix}${key}`;
  }

  public async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  public async openRead(key: string): Promise<Readable> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      );
    } catch (error) {
      if (isNotFound(error)) throw new StorageObjectNotFoundError(key);
      throw error;
    }

    const body = response.Body;
    if (body === undefined) throw new StorageObjectNotFoundError(key);
    // In Node the SDK hands back a Readable; the union covers browser types
    // this build never sees.
    return body as Readable;
  }

  public async put(key: string, contents: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: contents,
        ContentLength: contents.length,
      }),
    );
  }

  public async putFile(key: string, localPath: string, byteSize: number): Promise<void> {
    // ContentLength is given explicitly: without it the SDK buffers the whole
    // stream to discover the length, which for an archival scan means holding
    // the file in memory to upload a file.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: createReadStream(localPath),
        ContentLength: byteSize,
      }),
    );
  }
}

/** Whether an SDK error means "no such object or bucket". */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (named.name === 'NotFound' || named.name === 'NoSuchKey') return true;
  return named.$metadata?.httpStatusCode === 404;
}

// --- Construction ----------------------------------------------------------

/**
 * The backend this configuration asks for.
 *
 * Credentials are left to the SDK's own chain when none are configured, so an
 * EC2 instance role or a container credential provider works without putting
 * a long-lived key in the environment -- which is the better arrangement and
 * the one this application cannot supply on its own.
 */
export function createLocalBackend(root: string): StorageBackend {
  return new LocalBackend(root);
}

export function createStorageBackend(config: Config): StorageBackend {
  if (config.STORAGE_BACKEND === 'local') return new LocalBackend(config.STORAGE_ROOT);

  const client = new S3Client({
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT === '' ? {} : { endpoint: config.S3_ENDPOINT }),
    // Path style for anything that is not AWS: a bucket name in the hostname
    // needs DNS the operator may not control.
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ACCESS_KEY_ID === '' || config.S3_SECRET_ACCESS_KEY === ''
      ? {}
      : {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }),
  });

  return new S3Backend(config.S3_BUCKET, config.S3_PREFIX, client);
}
