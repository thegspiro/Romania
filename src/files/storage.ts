/**
 * Content-addressed file storage.
 *
 * Files are named by the SHA-256 of their bytes, never by anything a user
 * typed. That gives free deduplication, makes a storage key unguessable from
 * anything on a public page, and means a filename can never influence a path.
 *
 * `resolve` is the only way this codebase turns a stored key into a path, and
 * it refuses anything that could escape the storage root. It mirrors
 * `worker/storage.py`, which enforces the same rule on the Python side.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { StorageBackend } from './backend.js';

export class UnsafeStorageKeyError extends Error {
  public constructor(key: string) {
    super(`Refusing unsafe storage key: ${JSON.stringify(key)}`);
    this.name = 'UnsafeStorageKeyError';
  }
}

export class UnsupportedFileTypeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFileTypeError';
  }
}

/** Deliberately narrow: keys are generated from hex digests. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/**
 * The one rule for what a storage key may look like.
 *
 * Exported because the S3 backend applies it too. Traversal cannot escape a
 * bucket, but a key nothing else can address is still a bug, and a rule
 * enforced on one backend and not the other is the kind that rots quietly.
 */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new UnsafeStorageKeyError(key);
  }
}

export function resolveStoragePath(root: string, key: string): string {
  assertSafeKey(key);

  const rootResolved = resolvePath(root);
  const candidate = resolvePath(join(rootResolved, key));

  // Belt and braces: confirm containment after normalisation, so a key that
  // slipped past the pattern still cannot reach outside the root.
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    throw new UnsafeStorageKeyError(key);
  }
  return candidate;
}

/**
 * Storage key for an original.
 *
 * Sharded two levels deep so no single directory accumulates every file:
 * ext4 copes, but directory listings and backups do not.
 */
export function originalKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new UnsafeStorageKeyError(sha256);
  return `files/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** Storage key for a generated derivative. Matches `worker/storage.py`. */
export function derivativeKey(sha256: string, variant: string, extension: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new UnsafeStorageKeyError(sha256);
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(variant)) throw new UnsafeStorageKeyError(variant);
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new UnsafeStorageKeyError(extension);
  return `derivatives/${variant}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${extension}`;
}

// --- Type detection --------------------------------------------------------

interface Signature {
  mime: string;
  extension: string;
  /** Byte prefix, with null meaning "any byte at this position". */
  magic: (number | null)[];
  offset?: number;
}

/**
 * Magic-byte signatures.
 *
 * Type is decided by content, never by the filename: an attacker who can
 * choose `evil.jpg` for an HTML file would otherwise get stored XSS the moment
 * a browser sniffed it. Hand-written rather than taken from a dependency
 * because the list is short enough to audit in one screen.
 */
const SIGNATURES: readonly Signature[] = [
  { mime: 'image/jpeg', extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', extension: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  // TIFF, both byte orders. Archival scans are routinely TIFF.
  { mime: 'image/tiff', extension: 'tif', magic: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', extension: 'tif', magic: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: 'application/pdf', extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: 'audio/mpeg', extension: 'mp3', magic: [0x49, 0x44, 0x33] },
  { mime: 'audio/mpeg', extension: 'mp3', magic: [0xff, 0xfb] },
];

/** RIFF and ISO-BMFF containers need a second check further into the header. */
function detectContainer(header: Buffer): { mime: string; extension: string } | null {
  const ascii = (start: number, length: number): string =>
    header.subarray(start, start + length).toString('latin1');

  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 4);
    if (form === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
    if (form === 'WAVE') return { mime: 'audio/wav', extension: 'wav' };
    return null;
  }

  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('qt')) return { mime: 'video/quicktime', extension: 'mov' };
    return { mime: 'video/mp4', extension: 'mp4' };
  }

  return null;
}

export interface DetectedType {
  mime: string;
  extension: string;
}

/** Identifies a file from its leading bytes, or null when unrecognised. */
export function detectFileType(header: Buffer): DetectedType | null {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (header.length < offset + signature.magic.length) continue;

    const matches = signature.magic.every(
      (byte, index) => byte === null || header[offset + index] === byte,
    );
    if (matches) return { mime: signature.mime, extension: signature.extension };
  }

  return detectContainer(header);
}

/** How many leading bytes `detectFileType` needs. */
export const HEADER_BYTES = 16;

// --- Writing ---------------------------------------------------------------

export interface StoredFile {
  sha256: string;
  byteSize: number;
  mimeType: string;
  extension: string;
  storageKey: string;
  /** False when a file with these exact bytes was already stored. */
  isNew: boolean;
}

export class UploadTooLargeError extends Error {
  public constructor(limit: number) {
    super(`File exceeds the ${limit} byte limit`);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * Streams an upload to storage, hashing and type-sniffing as it goes.
 *
 * The bytes land in a scratch file first, for a reason that is not merely
 * convenience: the storage key is the SHA-256 of the contents, so it is not
 * known until the last byte has been read. Buffering to disk rather than to
 * memory keeps an archival scan from being held in RAM to be stored, and the
 * backend then moves or uploads a file whose length is already known.
 *
 * The scratch file is always local, whichever backend is configured. Nothing
 * is visible at the address its hash promises until the whole upload has
 * arrived, so a dropped connection leaves no truncated object.
 */
export async function storeStream(
  backend: StorageBackend,
  scratchRoot: string,
  stream: Readable,
  maxBytes: number,
): Promise<StoredFile> {
  const temporaryPath = join(scratchRoot, `upload-${randomUUID()}`);
  await mkdir(dirname(temporaryPath), { recursive: true });

  const hash = createHash('sha256');
  const header: Buffer[] = [];
  let headerBytes = 0;
  let byteSize = 0;
  let tooLarge = false;

  const measure = async function* (source: Readable): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      const buffer = chunk as Buffer;
      byteSize += buffer.length;
      if (byteSize > maxBytes) {
        tooLarge = true;
        // Stop consuming rather than writing gigabytes to disk before
        // rejecting the request.
        return;
      }
      hash.update(buffer);
      if (headerBytes < HEADER_BYTES) {
        header.push(buffer.subarray(0, HEADER_BYTES - headerBytes));
        headerBytes += Math.min(buffer.length, HEADER_BYTES - headerBytes);
      }
      yield buffer;
    }
  };

  try {
    await pipeline(stream, measure, createWriteStream(temporaryPath));

    if (tooLarge) throw new UploadTooLargeError(maxBytes);
    if (byteSize === 0) throw new UnsupportedFileTypeError('The file is empty.');

    const detected = detectFileType(Buffer.concat(header));
    if (detected === null) {
      throw new UnsupportedFileTypeError(
        'Unrecognised file type. Accepted: JPEG, PNG, GIF, TIFF, WebP, PDF, MP3, WAV, MP4.',
      );
    }

    const sha256 = hash.digest('hex');
    const storageKey = originalKey(sha256);

    // Identical bytes are already stored: keep what is there, which is
    // byte-for-byte the same, and discard the upload. Content addressing is
    // what makes that safe to assume rather than merely likely.
    const isNew = !(await backend.exists(storageKey));
    if (isNew) await backend.putFile(storageKey, temporaryPath, byteSize);

    return {
      sha256,
      byteSize,
      mimeType: detected.mime,
      extension: detected.extension,
      storageKey,
      isNew,
    };
  } finally {
    // No-op once the rename has happened.
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Writes a small generated file (an assembled document) into storage.
 *
 * No type sniffing: the bytes were produced by this application, not uploaded,
 * so the caller already knows what they are and records the media type on the
 * row that points here.
 */
export async function storeBuffer(
  backend: StorageBackend,
  contents: Buffer,
): Promise<{ sha256: string; byteSize: number; storageKey: string }> {
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const storageKey = originalKey(sha256);
  await backend.put(storageKey, contents);
  return { sha256, byteSize: contents.length, storageKey };
}
