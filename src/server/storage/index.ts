import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';

export interface ByteRange {
  start: number;
  end?: number;
}
export interface StoredStream {
  stream: Readable;
  /** Bytes in this response. */
  length: number;
  /** Bytes in the whole object. */
  total: number;
  start: number;
  end: number;
}

/**
 * Where files live. Two drivers with the same shape, picked by STORAGE_DRIVER:
 * a folder on disk, or any S3-compatible bucket (AWS, DigitalOcean Spaces, MinIO, R2).
 */
export interface Storage {
  driver: 'local' | 's3';
  putFile(key: string, filePath: string, contentType: string): Promise<void>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Copy an object to a local path so it can be processed. */
  toFile(key: string, dest: string): Promise<void>;
  open(key: string, range?: ByteRange): Promise<StoredStream>;
  /** A short-lived direct link, or null when files must be streamed through the app. */
  signedUrl(key: string, opts: { downloadName?: string; contentType?: string }): Promise<string | null>;
  remove(keys: string[]): Promise<void>;
  /** Fails loudly at startup if the folder or bucket is not usable. */
  check(): Promise<void>;
}

function resolveRange(total: number, range?: ByteRange) {
  let start = range?.start ?? 0;
  let end = range?.end ?? total - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= total) end = total - 1;
  if (start > end) start = end;
  return { start, end };
}

export class LocalStorage implements Storage {
  driver = 'local' as const;
  constructor(private root: string) {}

  private file(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Bad storage key');
    return full;
  }
  async putFile(key: string, filePath: string) {
    const dest = this.file(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(filePath, dest);
  }
  async putBuffer(key: string, data: Buffer) {
    const dest = this.file(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, data);
  }
  async toFile(key: string, dest: string) {
    await fsp.copyFile(this.file(key), dest);
  }
  async open(key: string, range?: ByteRange): Promise<StoredStream> {
    const file = this.file(key);
    const st = await fsp.stat(file);
    const { start, end } = resolveRange(st.size, range);
    return { stream: fs.createReadStream(file, { start, end }), length: end - start + 1, total: st.size, start, end };
  }
  async signedUrl() {
    return null;
  }
  async remove(keys: string[]) {
    await Promise.all(keys.map((k) => fsp.rm(this.file(k), { force: true })));
  }
  async check() {
    await fsp.mkdir(this.root, { recursive: true });
    const probe = path.join(this.root, '.write-test');
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe);
  }
}

export class S3Storage implements Storage {
  driver = 's3' as const;
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private delivery: 'redirect' | 'proxy';
  private ttl: number;

  constructor(cfg: Config) {
    this.client = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT || undefined,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
    });
    this.bucket = cfg.S3_BUCKET;
    this.prefix = cfg.S3_PREFIX.replace(/^\/+|\/+$/g, '');
    this.delivery = cfg.S3_DELIVERY;
    this.ttl = cfg.S3_URL_TTL_SECONDS;
  }
  private k(key: string) {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
  async putFile(key: string, filePath: string, contentType: string) {
    // Upload splits big files into parts, so a multi-gigabyte video does not sit in memory.
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: this.k(key), Body: fs.createReadStream(filePath), ContentType: contentType },
    }).done();
  }
  async putBuffer(key: string, data: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: data, ContentType: contentType }));
  }
  async toFile(key: string, dest: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    await pipeline(res.Body as Readable, fs.createWriteStream(dest));
  }
  async open(key: string, range?: ByteRange): Promise<StoredStream> {
    const Range = range ? `bytes=${range.start}-${range.end ?? ''}` : undefined;
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key), Range }));
    const length = Number(res.ContentLength ?? 0);
    let total = length;
    let start = 0;
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.ContentRange ?? '');
    if (m) {
      start = Number(m[1]);
      total = Number(m[3]);
    }
    return { stream: res.Body as Readable, length, total, start, end: start + length - 1 };
  }
  async signedUrl(key: string, opts: { downloadName?: string; contentType?: string }) {
    if (this.delivery === 'proxy') return null;
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.k(key),
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: opts.downloadName
        ? `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`
        : undefined,
      ResponseCacheControl: 'private, max-age=86400',
    });
    return getSignedUrl(this.client, cmd, { expiresIn: this.ttl });
  }
  async remove(keys: string[]) {
    for (let i = 0; i < keys.length; i += 900) {
      const batch = keys.slice(i, i + 900);
      if (!batch.length) continue;
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((k) => ({ Key: this.k(k) })), Quiet: true } }),
      );
    }
  }
  async check() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

export function createStorage(cfg: Config): Storage {
  return cfg.STORAGE_DRIVER === 's3' ? new S3Storage(cfg) : new LocalStorage(cfg.mediaDir);
}
