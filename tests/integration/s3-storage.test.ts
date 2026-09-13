/**
 * The S3 storage backend.
 *
 * Storage is the one thing both languages write: the web service stores
 * uploads and stages a document, the Python worker writes derivatives and
 * compiled output, and the web service serves what the worker wrote. So the
 * property that matters is not "S3 works" but **both backends address the same
 * keys, and one side can read what the other side wrote**.
 *
 * These run against a real S3 endpoint -- `moto[server]`, which speaks the
 * protocol over HTTP rather than mocking the client. A hand-rolled fake would
 * prove nothing about key encoding, streaming, content length or how the SDK
 * behaves on a missing object, which is where the bugs are.
 *
 * Without an endpoint the suite skips rather than fails, exactly as the
 * database suites do -- and, exactly as with those, a green run that skipped
 * this proves nothing. Set REQUIRE_TEST_S3=1 to turn an unreachable endpoint
 * into a failure; CI sets it.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  createLocalBackend,
  createStorageBackend,
  StorageObjectNotFoundError,
  type StorageBackend,
} from '../../src/files/backend.js';
import {
  originalKey,
  storeBuffer,
  storeStream,
  UnsafeStorageKeyError,
} from '../../src/files/storage.js';
import { createHarness, testConfig, truncateContent, type Harness } from './helpers.js';
import { migrateStorage, storageKeysInUse } from '../../src/files/migrate.js';
import { insertFileObject } from '../../src/files/repository.js';

const ENDPOINT = process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:5000';

function required(): boolean {
  const value = process.env['REQUIRE_TEST_S3'];
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** True when an S3 endpoint answers with the test credentials. */
async function s3Available(): Promise<boolean> {
  try {
    const response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(2000) });
    // Any HTTP answer means something is listening and speaking.
    return response.status > 0;
  } catch (error) {
    if (required()) {
      throw new Error(`REQUIRE_TEST_S3 is set but nothing answered at ${ENDPOINT}`, {
        cause: error,
      });
    }
    return false;
  }
}

const available = await s3Available();

describe.skipIf(!available)('s3 storage backend', () => {
  const bucket = `dissertation-test-${randomUUID().slice(0, 8)}`;
  let backend: StorageBackend;
  let scratch: string;

  function configured(overrides: Record<string, string> = {}) {
    return testConfig({
      STORAGE_BACKEND: 's3',
      S3_BUCKET: bucket,
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: ENDPOINT,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test',
      ...overrides,
    });
  }

  beforeAll(async () => {
    const client = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    backend = createStorageBackend(configured());
    scratch = await mkdtemp(join(tmpdir(), 'dissertation-s3-'));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function readAll(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  describe('the interface both backends implement', () => {
    it('round-trips bytes and reports its kind', async () => {
      expect(backend.kind).toBe('s3');
      const key = `files/aa/bb/${randomUUID().replace(/-/g, '')}`;
      await backend.put(key, Buffer.from('archival scan'));

      expect(await backend.exists(key)).toBe(true);
      expect((await readAll(await backend.openRead(key))).toString()).toBe('archival scan');
    });

    it('reports a missing key the same way the local backend does', async () => {
      // Both must raise the same error, because every serving route turns
      // exactly this into a 404 -- and a backend that threw something else
      // would surface as a 500 that tells a visitor the item exists.
      const missing = 'files/00/00/nothing-is-stored-here';
      const local = createLocalBackend(scratch);

      await expect(backend.openRead(missing)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
      await expect(local.openRead(missing)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
      expect(await backend.exists(missing)).toBe(false);
      expect(await local.exists(missing)).toBe(false);
    });

    it('refuses an unsafe key, as the local backend does', async () => {
      // Traversal cannot escape a bucket, but a key nothing else can address
      // is still a bug, and the rule has to hold on both sides or it rots.
      for (const key of ['../escape', '/absolute', 'files/../../etc/passwd']) {
        await expect(backend.put(key, Buffer.from('x'))).rejects.toBeInstanceOf(
          UnsafeStorageKeyError,
        );
      }
    });

    it('stores a local file with its length, and reads it back whole', async () => {
      // putFile passes ContentLength explicitly; without it the SDK buffers
      // the whole stream in memory to discover the length.
      const bytes = Buffer.from('x'.repeat(200_000));
      const path = join(scratch, 'large.bin');
      await writeFile(path, bytes);

      const key = `files/cc/dd/${randomUUID().replace(/-/g, '')}`;
      await backend.putFile(key, path, bytes.length);

      expect((await readAll(await backend.openRead(key))).length).toBe(bytes.length);
    });

    it('passes its own reachability check', async () => {
      await expect(backend.check()).resolves.toBeUndefined();
    });

    it('fails the reachability check against a bucket that is not there', async () => {
      // The check exists so preflight reports this at install time rather
      // than letting the first upload discover it.
      const wrong = createStorageBackend(configured({ S3_BUCKET: 'no-such-bucket-here' }));
      await expect(wrong.check()).rejects.toBeTruthy();
    });
  });

  describe('uploads', () => {
    function png(payload: string): Buffer {
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(payload),
      ]);
    }

    it('hashes, sniffs and stores through the backend', async () => {
      const bytes = png(randomUUID());
      const stored = await storeStream(backend, scratch, Readable.from([bytes]), 1_000_000);

      expect(stored.mimeType).toBe('image/png');
      expect(stored.storageKey).toBe(originalKey(stored.sha256));
      expect(stored.isNew).toBe(true);
      expect((await readAll(await backend.openRead(stored.storageKey))).equals(bytes)).toBe(true);
    });

    it('deduplicates identical bytes against what the bucket already holds', async () => {
      const bytes = png(randomUUID());
      const first = await storeStream(backend, scratch, Readable.from([bytes]), 1_000_000);
      const second = await storeStream(backend, scratch, Readable.from([bytes]), 1_000_000);

      expect(second.sha256).toBe(first.sha256);
      expect(second.isNew).toBe(false);
    });

    it('leaves no scratch file behind, whichever backend is configured', async () => {
      const { readdir } = await import('node:fs/promises');
      await storeStream(backend, scratch, Readable.from([png(randomUUID())]), 1_000_000);
      const leftovers = (await readdir(scratch)).filter((name) => name.startsWith('upload-'));
      expect(leftovers).toEqual([]);
    });

    it('stores a generated document at its content address', async () => {
      const contents = Buffer.from(`# Assembled\n\n${randomUUID()}\n`);
      const stored = await storeBuffer(backend, contents);

      expect(stored.storageKey).toBe(originalKey(stored.sha256));
      expect((await readAll(await backend.openRead(stored.storageKey))).equals(contents)).toBe(
        true,
      );
    });
  });

  describe('agreement with the local backend', () => {
    it('produces the same storage key for the same bytes', async () => {
      // The keys are the contract between the two backends, the two
      // languages, and every row in file_object. If these ever differ,
      // switching backends silently orphans the whole corpus.
      const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('same bytes either side'),
      ]);
      const local = createLocalBackend(scratch);

      const viaS3 = await storeStream(backend, scratch, Readable.from([bytes]), 1_000_000);
      const viaLocal = await storeStream(local, scratch, Readable.from([bytes]), 1_000_000);

      expect(viaS3.storageKey).toBe(viaLocal.storageKey);
      expect(viaS3.sha256).toBe(viaLocal.sha256);
      expect(viaS3.mimeType).toBe(viaLocal.mimeType);
    });
  });
});

/**
 * Moving a corpus between backends.
 *
 * Switching `STORAGE_BACKEND` changes where bytes are looked for, not where
 * they are, so without this every existing file becomes a 404 -- the failure
 * that matters most for a corpus of archival scans, and the one an operator
 * would hear about from a reader rather than a log.
 */
describe.skipIf(!available)('storage migration', () => {
  let harness: Harness;
  let local: StorageBackend;
  let target: StorageBackend;
  let scratch: string;
  const bucket = `dissertation-migrate-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    harness = await createHarness();
    scratch = await mkdtemp(join(tmpdir(), 'dissertation-migrate-'));
    local = createLocalBackend(scratch);

    const client = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    target = createStorageBackend(
      testConfig({
        STORAGE_BACKEND: 's3',
        S3_BUCKET: bucket,
        S3_ENDPOINT: ENDPOINT,
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: 'test',
        S3_SECRET_ACCESS_KEY: 'test',
      }),
    );
  });

  afterAll(async () => {
    await harness?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  /** A file_object row whose bytes are in the local backend. */
  async function seed(contents: string): Promise<string> {
    const stored = await storeBuffer(local, Buffer.from(contents));
    await insertFileObject(harness.pool, {
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      mimeType: 'application/octet-stream',
      originalFilename: 'seed.bin',
      storageKey: stored.storageKey,
    });
    return stored.storageKey;
  }

  it('copies what the database knows about, and nothing else', async () => {
    const key = await seed(`recorded ${randomUUID()}`);
    // A file on disk that no row points at is not part of the corpus.
    // Copying it would import somebody's stray backup into the bucket.
    const stray = await storeBuffer(local, Buffer.from(`stray ${randomUUID()}`));

    const summary = await migrateStorage(harness.pool, local, target);

    expect(summary.copied).toBe(1);
    expect(summary.missing).toEqual([]);
    expect(await target.exists(key)).toBe(true);
    expect(await target.exists(stray.storageKey)).toBe(false);
  });

  it('is re-runnable, and skips what is already there', async () => {
    await seed(`idempotent ${randomUUID()}`);

    const first = await migrateStorage(harness.pool, local, target);
    const second = await migrateStorage(harness.pool, local, target);

    expect(first.copied).toBe(1);
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('never deletes from the source', async () => {
    // An operator who switches and regrets it switches back, so the old
    // backend has to stay intact and complete.
    const key = await seed(`still there ${randomUUID()}`);
    await migrateStorage(harness.pool, local, target);
    expect(await local.exists(key)).toBe(true);
  });

  it('copies nothing on a dry run but reports what it would', async () => {
    await seed(`dry ${randomUUID()}`);
    const summary = await migrateStorage(harness.pool, local, target, { dryRun: true });

    expect(summary.copied).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);
    const keys = await storageKeysInUse(harness.pool);
    expect(await target.exists(keys[0]!)).toBe(false);
  });

  it('reports a row whose bytes are absent rather than failing the run', async () => {
    // Pre-existing damage this command finds rather than causes. The rest of
    // the corpus still has to move.
    await insertFileObject(harness.pool, {
      sha256: 'f'.repeat(64),
      byteSize: 3,
      mimeType: 'application/octet-stream',
      originalFilename: 'gone.bin',
      storageKey: `files/ff/ff/${'f'.repeat(64)}`,
    });
    const present = await seed(`survivor ${randomUUID()}`);

    const summary = await migrateStorage(harness.pool, local, target);

    expect(summary.missing).toHaveLength(1);
    expect(summary.copied).toBe(1);
    expect(await target.exists(present)).toBe(true);
  });

  it('verifies the bytes arrived when asked to', async () => {
    await seed(`verified ${randomUUID()}`);
    const summary = await migrateStorage(harness.pool, local, target, { verify: true });
    expect(summary.corrupted).toEqual([]);
    expect(summary.copied).toBe(1);
  });
});
