import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** Public address people type in the browser, for example https://photos.example.com. */
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  DATABASE_URL: z.string().default('postgres://afterimage:afterimage@db:5432/afterimage'),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: bool(true),
  SESSION_DAYS: z.coerce.number().default(30),

  /** Sign-in. Local accounts are on unless turned off. OIDC (SolPersona) turns on when the three values are set. */
  LOCAL_AUTH: bool(true),
  OIDC_NAME: z.string().default('SolPersona'),
  OIDC_ISSUER: z.string().default(''),
  OIDC_CLIENT_ID: z.string().default(''),
  OIDC_CLIENT_SECRET: z.string().default(''),
  OIDC_SCOPES: z.string().default('openid profile email'),

  /**
   * Email through Resend, for invites and password reset links. It turns on when RESEND_API_KEY is set.
   * MAIL_FROM is the sender, for example "ImageStoria <photos@example.com>". Its domain must be verified in Resend first.
   */
  RESEND_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().default(''),
  MAIL_REPLY_TO: z.string().default(''),

  /** Where files live: "local" (a folder) or "s3" (any S3-compatible bucket). */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  DATA_DIR: z.string().default('/data'),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_PREFIX: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool(false),
  /** "redirect" hands the browser a short-lived signed link. "proxy" streams every file through this app. */
  S3_DELIVERY: z.enum(['redirect', 'proxy']).default('redirect'),
  S3_URL_TTL_SECONDS: z.coerce.number().default(3600),

  MAX_UPLOAD_MB: z.coerce.number().default(8192),
  DISPLAY_LONG_EDGE: z.coerce.number().default(1600),
  THUMB_HEIGHT: z.coerce.number().default(360),
  INGEST_CONCURRENCY: z.coerce.number().default(2),
  /** Reels: the most items one may hold, and the longest stretch of any one video that goes in. */
  REEL_MAX_ITEMS: z.coerce.number().min(1).default(200),
  REEL_VIDEO_MAX_SECONDS: z.coerce.number().min(1).default(20),
  /**
   * A copy every browser can play, for videos that need one. "auto" makes it only when the original would not play,
   * "always" for every video, "never" for none. The copy's long edge is at most VIDEO_COPY_MAX_EDGE pixels.
   */
  VIDEO_COPY: z.enum(['auto', 'always', 'never']).default('auto'),
  VIDEO_COPY_MAX_EDGE: z.coerce.number().min(320).max(7680).default(1920),
  VIDEO_COPY_TIMEOUT_MINUTES: z.coerce.number().min(1).default(180),
  /**
   * Backups of the database, written to the same storage as the files, under backups/.
   * BACKUP_SCHEDULE is empty (off) or a time of day on the server's clock, such as 03:30. BACKUP_KEEP is how many to keep.
   * With BACKUP_PASSPHRASE set the dump is encrypted before it is stored. PG_DUMP is the program to run.
   */
  BACKUP_SCHEDULE: z.string().trim().regex(/^(|off|([01]?\d|2[0-3]):[0-5]\d)$/i, 'BACKUP_SCHEDULE must be empty, off, or a time of day such as 03:30.').default('').transform((v) => (/^off$/i.test(v) ? '' : v)),
  BACKUP_KEEP: z.coerce.number().int().min(1).default(14),
  BACKUP_PASSPHRASE: z.string().default(''),
  PG_DUMP: z.string().default('pg_dump'),
  /**
   * Workers on your own machines read the pictures. A worker holds each item it claims for AI_LEASE_MINUTES;
   * if it goes quiet for that long the item goes back in line. After AI_MAX_ATTEMPTS tries a task is marked failed.
   */
  AI_LEASE_MINUTES: z.coerce.number().min(1).max(1440).default(10),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  /** Which kinds of work the site hands out: caption, embed, faces, place. Leave one out to turn it off for every worker. */
  AI_TASKS: z.string().default('caption,embed,faces,place').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  /**
   * Search by meaning. EMBED_MODEL is the image and text model: the worker's [embed] model must be the same one.
   * The text half runs on this server's CPU unless EMBED_TEXT is false. EMBED_TEXT_DTYPE picks the file: q8 (small) or fp32 (exact).
   * A result is kept when it scores at least SEARCH_MEANING_FLOOR and within SEARCH_MEANING_SPREAD of the best one.
   * The defaults were set on a real library with the default model: words that fit a picture score 0.11 to 0.19 there,
   * and words that fit nothing stay under 0.08. Another model needs other numbers.
   */
  EMBED_MODEL: z.string().default('onnx-community/siglip2-base-patch16-224-ONNX'),
  EMBED_TEXT: bool(true),
  EMBED_TEXT_DTYPE: z.enum(['q8', 'fp32', 'fp16', 'q4']).default('q8'),
  /** The text model is let go of this many minutes after the last search, to give its memory back. 0 keeps it loaded. */
  EMBED_TEXT_IDLE_MINUTES: z.coerce.number().min(0).default(15),
  SEARCH_MEANING_MAX: z.coerce.number().int().min(1).max(500).default(60),
  SEARCH_MEANING_FLOOR: z.coerce.number().default(0.085),
  SEARCH_MEANING_SPREAD: z.coerce.number().default(0.03),
  /** "More like this" offers the closest pictures that are at least this alike. Two unrelated photographs are about 0.8 alike with the default model. */
  SIMILAR_FLOOR: z.coerce.number().default(0.9),
  /**
   * Near duplicates: how alike a picture must look to the first of its group, from 0 to 1, and how soon it must follow
   * the one before it. Strict on purpose: frames of one burst are 0.97 alike or more, and a second or two apart.
   */
  DUPLICATE_SIMILARITY: z.coerce.number().min(0.5).max(1).default(0.97),
  DUPLICATE_MINUTES: z.coerce.number().min(0).default(2),
  /**
   * People. All of these are likenesses from 0 to 1 between two faces. Two unnamed faces at least FACE_CLUSTER alike are
   * grouped. A face at least FACE_SUGGEST like a named person is offered as a suggestion. Automatic naming, when the owner
   * turns it on, starts at FACE_AUTO (the owner picks the real threshold on the People page), needs FACE_AUTO_MIN_CONFIRMED
   * confirmed faces of the person and a lead of FACE_GAP over the next closest person, and gets FACE_STRICT_STEP stricter for
   * a person each time one of their automatic names is undone. FACE_LOOK separates the distinct looks of one person over time.
   */
  FACE_CLUSTER: z.coerce.number().min(0).max(1).default(0.45),
  FACE_SUGGEST: z.coerce.number().min(0).max(1).default(0.35),
  FACE_AUTO: z.coerce.number().min(0).max(1).default(0.6),
  FACE_GAP: z.coerce.number().min(0).max(1).default(0.1),
  FACE_AUTO_MIN_CONFIRMED: z.coerce.number().int().min(1).default(5),
  FACE_STRICT_STEP: z.coerce.number().min(0).max(0.5).default(0.03),
  FACE_LOOK: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * Suggested locations for pictures that have none. A picture borrows the location of one the same camera took within
   * PLACE_NEARBY_MINUTES (0 turns this off). A place a vision model names is shown when it is at least PLACE_SUGGEST_MIN sure.
   */
  PLACE_NEARBY_MINUTES: z.coerce.number().min(0).max(1440).default(10),
  PLACE_SUGGEST_MIN: z.coerce.number().min(0).max(1).default(0.6),
  /** Days a deleted item stays in the trash before it is removed for good. 0 means never. */
  TRASH_DAYS: z.coerce.number().min(0).default(0),

  MAP_STYLE_DARK: z.string().default('https://tiles.openfreemap.org/styles/dark'),
  MAP_STYLE_LIGHT: z.string().default('https://tiles.openfreemap.org/styles/positron'),
  MAP_STYLE_FALLBACK: z.string().default('https://tiles.openfreemap.org/styles/liberty'),
});

export type Config = z.infer<typeof schema> & {
  mediaDir: string;
  tmpDir: string;
  secureCookies: boolean;
  oidcEnabled: boolean;
  publicOrigin: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  if (c.STORAGE_DRIVER === 's3' && (!c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
  }
  if (c.RESEND_API_KEY && !/[^@\s<]+@[^@\s>]+\.[^@\s>]+/.test(c.MAIL_FROM)) {
    throw new Error('RESEND_API_KEY is set, so MAIL_FROM must say who the mail comes from. For example: MAIL_FROM=ImageStoria <photos@example.com>');
  }
  const publicUrl = c.PUBLIC_URL.replace(/\/+$/, '');
  const oidcEnabled = Boolean(c.OIDC_ISSUER && c.OIDC_CLIENT_ID);
  if (!c.LOCAL_AUTH && !oidcEnabled) {
    throw new Error('No way to sign in: LOCAL_AUTH is off and OIDC_ISSUER / OIDC_CLIENT_ID are not set.');
  }
  return {
    ...c,
    PUBLIC_URL: publicUrl,
    OIDC_ISSUER: c.OIDC_ISSUER.replace(/\/+$/, ''),
    mediaDir: path.join(c.DATA_DIR, 'media'),
    tmpDir: path.join(c.DATA_DIR, 'tmp'),
    secureCookies: publicUrl.startsWith('https://'),
    oidcEnabled,
    publicOrigin: new URL(publicUrl).origin,
  };
}
