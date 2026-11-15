/**
 * Copy the pictures between this server's media folder and a bucket, for moving a library (see the README).
 *
 *   npm run media:push    every file under the media folder goes to the bucket named by the S3_ settings
 *   npm run media:pull    every file in that bucket (under S3_PREFIX) comes to the media folder
 *
 * A file that is already there with the same size is skipped, so a copy that was interrupted can simply be run again.
 * Files are streamed one at a time. Nothing is deleted on either side.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { loadConfig } from './config.js';
import { mimeFor } from './media/ingest.js';

const dir = process.argv[2];
if (dir !== 'push' && dir !== 'pull') { console.error('Say which way: npm run media:push (this server to the bucket) or npm run media:pull (the bucket to this server).'); process.exit(2); }
// Only the folder and the S3_ settings are read. STORAGE_DRIVER can stay "local": that is the usual case for a push.
const cfg = loadConfig({ ...process.env, STORAGE_DRIVER: 'local', DATABASE_URL: process.env.DATABASE_URL || 'postgres://unused' });
if (!cfg.S3_BUCKET || !cfg.S3_ACCESS_KEY_ID || !cfg.S3_SECRET_ACCESS_KEY) { console.error('Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (and S3_ENDPOINT, S3_REGION, S3_PREFIX as the bucket needs) to say where the bucket is.'); process.exit(2); }

const client = new S3Client({ region: cfg.S3_REGION, endpoint: cfg.S3_ENDPOINT || undefined, forcePathStyle: cfg.S3_FORCE_PATH_STYLE, credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } });
const prefix = cfg.S3_PREFIX.replace(/^\/+|\/+$/g, ''), inBucket = (key: string) => (prefix ? `${prefix}/${key}` : key), root = path.resolve(cfg.mediaDir);
let copied = 0, skipped = 0, failed = 0, bytes = 0, last = 0;
const say = (force = false) => { if (!force && Date.now() - last < 2000) return; last = Date.now(); console.log(`${copied} copied (${(bytes / 1048576).toFixed(1)} MB), ${skipped} already there${failed ? `, ${failed} failed` : ''}`); };

async function* walk(folder: string): AsyncGenerator<string> {
  for (const e of await fsp.readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, e.name);
    if (e.isDirectory()) yield* walk(full); else if (e.isFile() && e.name !== '.write-test') yield full;
  }
}
async function sizeInBucket(key: string): Promise<number | null> {
  try { return Number((await client.send(new HeadObjectCommand({ Bucket: cfg.S3_BUCKET, Key: inBucket(key) }))).ContentLength ?? 0); }
  catch (e: any) { if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null; throw e; }
}

async function push() {
  if (!fs.existsSync(root)) { console.error(`There is no media folder at ${root}.`); process.exit(1); }
  for await (const file of walk(root)) {
    const key = path.relative(root, file).split(path.sep).join('/'), size = (await fsp.stat(file)).size;
    try {
      if ((await sizeInBucket(key)) === size) { skipped++; say(); continue; }
      await new Upload({ client, params: { Bucket: cfg.S3_BUCKET, Key: inBucket(key), Body: fs.createReadStream(file), ContentType: mimeFor(key) } }).done();
      copied++; bytes += size;
    } catch (e: any) { failed++; console.error(`${key} could not be copied: ${e?.message ?? e}`); }
    say();
  }
}

async function pull() {
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: cfg.S3_BUCKET, Prefix: prefix ? prefix + '/' : undefined, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      const key = prefix ? o.Key!.slice(prefix.length + 1) : o.Key!, dest = path.resolve(root, key), size = Number(o.Size ?? 0);
      if (!key || key.endsWith('/') || !dest.startsWith(root + path.sep)) continue;
      try {
        const have = await fsp.stat(dest).then((s) => s.size, () => -1);
        if (have === size) { skipped++; say(); continue; }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: o.Key! }));
        // To a working name first, so a copy that is cut off never looks like a whole file.
        await pipeline(res.Body as Readable, fs.createWriteStream(dest + '.part'));
        await fsp.rename(dest + '.part', dest);
        copied++; bytes += size;
      } catch (e: any) { failed++; console.error(`${key} could not be copied: ${e?.message ?? e}`); }
      say();
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

try {
  await (dir === 'push' ? push() : pull());
  say(true);
  console.log(failed ? `Done, but ${failed} ${failed === 1 ? 'file was' : 'files were'} not copied. Run it again to try those.` : dir === 'push' ? `Done. Everything under ${root} is in the bucket ${cfg.S3_BUCKET}${prefix ? ` under ${prefix}/` : ''}.` : `Done. Everything in the bucket ${cfg.S3_BUCKET}${prefix ? ` under ${prefix}/` : ''} is under ${root}.`);
  if (failed) process.exitCode = 1;
} catch (e: any) { console.error(`The copy stopped. ${e?.message ?? e}`); process.exitCode = 1; }
finally { client.destroy(); }
