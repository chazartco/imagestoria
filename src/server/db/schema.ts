import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Small key/value store: setup state, library name. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    name: text('name').notNull(),
    email: text('email'),
    handle: text('handle'),
    passwordHash: text('password_hash'),
    /** owner | editor | commenter | viewer */
    role: text('role').notNull().default('viewer'),
    /** Per-person switches on top of the role: upload, edit, tag, comment, download. */
    caps: jsonb('caps').$type<Record<string, boolean>>().notNull().default({}),
    color: text('color').notNull().default('#ffb224'),
    /** A profile picture the person chose: where its small square copy is stored. Empty shows their initial instead. */
    avatarKey: text('avatar_key'),
    /** active | pending (invited, not yet joined) | disabled */
    status: text('status').notNull().default('active'),
    oidcSubject: text('oidc_subject'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    uniqueIndex('users_oidc_subject_uq').on(t.oidcSubject),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha-256 of the cookie value. The cookie itself is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** One-time links: an invite to join, or a password reset the owner hands to someone. */
export const tokens = pgTable('tokens', {
  tokenHash: text('token_hash').primaryKey(),
  kind: text('kind').notNull(), // invite | reset
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const spaces = pgTable('spaces', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** "life" groups by month and shows places first. "studio" groups by series. */
  kind: text('kind').notNull().default('life'),
  position: integer('position').notNull().default(0),
  /** People recognition is on for this space. Off until the owner turns it on. */
  people: boolean('people').notNull().default(false),
  createdAt: createdAt(),
});

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] })],
);

export const places = pgTable(
  'places',
  {
    id: id(),
    name: text('name').notNull(),
    region: text('region').notNull().default(''),
    country: text('country').notNull().default(''),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
  },
  (t) => [uniqueIndex('places_name_uq').on(t.name, t.region, t.country)],
);

export const items = pgTable(
  'items',
  {
    id: id(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    kind: text('kind').notNull().default('photo'), // photo | video
    /** processing | ready | failed */
    status: text('status').notNull().default('processing'),
    error: text('error'),
    fileName: text('file_name').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull().default(0),
    height: integer('height').notNull().default(0),
    duration: real('duration'),
    /** The moment on the camera's own clock, stored without a time zone so it reads the same everywhere. */
    takenAt: timestamp('taken_at', { withTimezone: false }).notNull(),
    /** Where the date came from: exif (the camera wrote it), file (the file's last-modified time) or manual (a person set it). Empty for rows older than this column. */
    dateSource: text('date_source'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    placeId: uuid('place_id').references(() => places.id, { onDelete: 'set null' }),
    /** Where the location came from: exif (read from the file), manual (set by a person) or suggested (a suggestion a person accepted). Empty when there is none. */
    locationSource: text('location_source'),
    /** The place finer than the town, when the place data knows one: a beach, a park, a landmark, a neighbourhood. And what kind it is. */
    spot: text('spot'),
    spotKind: text('spot_kind'),
    camera: text('camera'),
    lens: text('lens'),
    iso: integer('iso'),
    shutter: text('shutter'),
    fnum: real('fnum'),
    focal: real('focal'),
    palette: text('palette').array().notNull().default(sql`'{}'::text[]`),
    series: text('series'),
    copyOf: uuid('copy_of'),
    recipe: jsonb('recipe'),
    /** Storage keys. "full" exists only when the original cannot be shown by a browser (HEIC, TIFF). */
    origKey: text('orig_key').notNull(),
    displayKey: text('display_key'),
    thumbKey: text('thumb_key'),
    fullKey: text('full_key'),
    bytesOrig: bigint('bytes_orig', { mode: 'number' }).notNull().default(0),
    bytesDisplay: bigint('bytes_display', { mode: 'number' }).notNull().default(0),
    bytesThumb: bigint('bytes_thumb', { mode: 'number' }).notNull().default(0),
    bytesFull: bigint('bytes_full', { mode: 'number' }).notNull().default(0),
    /** Videos only: a copy every browser can play, when the original is not one (see media/playcopy.ts). */
    playKey: text('play_key'),
    bytesPlay: bigint('bytes_play', { mode: 'number' }).notNull().default(0),
    /** null (not looked at yet), none (plays as it is), queued, making, ready, failed. */
    playStatus: text('play_status'),
    playError: text('play_error'),
    /** Phase 3: filled in by the worker on the owner's GPU machine. none | queued | done */
    aiStatus: text('ai_status').notNull().default('none'),
    aiScene: text('ai_scene'),
    aiCaption: text('ai_caption'),
    /** Words the worker could read in the picture: a sign, a label, a page. */
    aiText: text('ai_text'),
    /** What a person has corrected by hand: "caption", "scene". A worker's later reading never overwrites these. */
    aiLocked: text('ai_locked').array().notNull().default(sql`'{}'::text[]`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('items_space_taken_idx').on(t.spaceId, t.takenAt),
    index('items_updated_idx').on(t.updatedAt),
    uniqueIndex('items_sha_uq').on(t.sha256).where(sql`${t.deletedAt} is null and ${t.copyOf} is null`),
  ],
);

/** Phase 3: things the worker saw in a picture, each with a confidence. */
export const itemLabels = pgTable(
  'item_labels',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    confidence: real('confidence').notNull().default(1),
    /** Who said so: ai (a worker) or person. */
    source: text('source').notNull().default('ai'),
    /** A person removed this label. The row stays so that reading the picture again does not bring it back. */
    removed: boolean('removed').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.label] })],
);

export const tags = pgTable('tags', {
  id: id(),
  name: text('name').notNull().unique(),
});

export const itemTags = pgTable(
  'item_tags',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] })],
);

export const likes = pgTable(
  'likes',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.userId] })],
);

export const comments = pgTable(
  'comments',
  {
    id: id(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('comments_item_idx').on(t.itemId)],
);

export const stories = pgTable('stories', {
  id: id(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  intro: text('intro').notNull().default(''),
  /** The first of coverIds, kept in step with it so older code and queries still find a cover. */
  coverItemId: uuid('cover_item_id'),
  /** The pictures on the cover, up to four, in the order the author chose them. */
  coverIds: uuid('cover_ids').array().notNull().default(sql`'{}'::uuid[]`),
  /** Text the author wrote for each automatic part of the story, keyed by the part's date. Sections made by hand keep their own text. */
  notes: jsonb('notes').$type<Record<string, string>>().notNull().default({}),
  /** People, besides owner and editors, who may read it. */
  sharedWith: uuid('shared_with').array().notNull().default(sql`'{}'::uuid[]`),
  /** Groups the story belongs to, such as "Sunsets" or "Road trips". A story can be in several. */
  groups: text('groups').array().notNull().default(sql`'{}'::text[]`),
  /** The music that plays under the slideshow and in reels: "builtin:<name>", a music_tracks id, or empty for none. */
  music: text('music'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/**
 * Sections the author made by hand. A story with no rows here arranges itself by date, as every story
 * did before. With rows here, the order of sections and of the pictures inside them is the author's.
 */
export const storySections = pgTable(
  'story_sections',
  {
    id: id(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    title: text('title').notNull().default(''),
    text: text('text').notNull().default(''),
  },
  (t) => [index('story_sections_story_idx').on(t.storyId, t.position)],
);

export const storyItems = pgTable(
  'story_items',
  {
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    /** Empty while the story arranges itself. */
    sectionId: uuid('section_id').references(() => storySections.id, { onDelete: 'set null' }),
    /** The picture's place inside its section. */
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.storyId, t.itemId] })],
);

/**
 * Public links to a story. Anyone who has the link can open the story without signing in, within what
 * the link allows. A story can have several, each with its own options. Deleting the row ends the link.
 * This is the one exception to "signed-in people only".
 */
export const storyLinks = pgTable(
  'story_links',
  {
    id: id(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    /** The secret in the address. Kept as written so the owner can copy the link again later. */
    token: text('token').notNull().unique(),
    label: text('label').notNull().default(''),
    allowDownload: boolean('allow_download').notNull().default(false),
    /** Visitors may add their own photos and videos to the story. */
    allowAdd: boolean('allow_add').notNull().default(false),
    /** Argon2 hash. When set, the link asks for this password first. */
    passwordHash: text('password_hash'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    uses: integer('uses').notNull().default(0),
  },
  (t) => [index('story_links_story_idx').on(t.storyId)],
);

/**
 * A look of your own: a 3D lookup table read from a .cube file. `key` is where its numbers are stored.
 * A removed look that a saved copy still uses keeps its row and numbers, with `removedAt` set, so the copy can be rendered again.
 */
export const luts = pgTable('luts', {
  id: id(),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  sha: text('sha').notNull(),
  key: text('key').notNull(),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
});

/** Music the owner uploaded, to play under slideshows and reels. The built-in tracks are made by the server and need no row. */
export const musicTracks = pgTable('music_tracks', {
  id: id(),
  name: text('name').notNull(),
  key: text('key').notNull(),
  mime: text('mime').notNull().default('audio/mpeg'),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  duration: real('duration'),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** A video made from a story, in a tall or a wide frame. Rendered in the background by ffmpeg. */
export const reels = pgTable(
  'reels',
  {
    id: id(),
    /** The story it was made from. Empty for a reel made straight from pictures chosen in the library. */
    storyId: uuid('story_id').references(() => stories.id, { onDelete: 'cascade' }),
    /** A reel made from the library: the space it belongs to, its pictures, its title (may be empty) and the pictures on its card, up to four. */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    itemIds: uuid('item_ids').array().notNull().default(sql`'{}'::uuid[]`),
    title: text('title').notNull().default(''),
    coverIds: uuid('cover_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** "9:16" or "16:9" */
    format: text('format').notNull(),
    music: text('music'),
    secondsPerPhoto: real('seconds_per_photo').notNull().default(3.5),
    /** queued | running | ready | failed */
    status: text('status').notNull().default('queued'),
    /** 0 to 1 while it is being made */
    progress: real('progress').notNull().default(0),
    error: text('error'),
    key: text('key'),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    duration: real('duration'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('reels_story_idx').on(t.storyId)],
);

/**
 * What a picture looks like, as numbers from an image and text model, for search by meaning, "More like this" and near duplicates.
 * `vec` holds `dim` little-endian 32-bit floats with length 1. `model` says which model made them: numbers from two models cannot be compared.
 */
export const itemEmbeddings = pgTable(
  'item_embeddings',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    dim: integer('dim').notNull(),
    vec: bytea('vec').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('item_embeddings_updated_idx').on(t.updatedAt)],
);

/** Someone who appears in the pictures of one space. Not a person who signs in: those are `users`. */
export const persons = pgTable(
  'persons',
  {
    id: id(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    coverFaceId: uuid('cover_face_id'),
    /** How many automatic names for this person have been undone. Each one raises the bar for naming them automatically. */
    strict: integer('strict').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('persons_space_idx').on(t.spaceId)],
);

/**
 * A face found in a picture. x, y, w and h are fractions of the picture. `vec` is its embedding: biometric data,
 * never sent to a browser and never logged. status: unsorted | suggested | confirmed | auto | ignored | notface.
 */
export const faces = pgTable(
  'faces',
  {
    id: id(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    x: real('x').notNull(),
    y: real('y').notNull(),
    w: real('w').notNull(),
    h: real('h').notNull(),
    score: real('score').notNull().default(0),
    quality: real('quality').notNull().default(0),
    vec: bytea('vec').notNull(),
    model: text('model').notNull(),
    personId: uuid('person_id').references(() => persons.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('unsorted'),
    /** For a suggestion: who it might be, and how alike. */
    suggestedId: uuid('suggested_id').references(() => persons.id, { onDelete: 'set null' }),
    confidence: real('confidence'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('faces_item_idx').on(t.itemId), index('faces_person_idx').on(t.personId), index('faces_status_idx').on(t.status)],
);

/** "This face is not that person." Kept so the same wrong suggestion is never made twice. */
export const faceRejections = pgTable(
  'face_rejections',
  {
    faceId: uuid('face_id')
      .notNull()
      .references(() => faces.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.faceId, t.personId] })],
);

/** Named places finer than towns, loaded from GeoNames by the operator (see media/spots.ts). Empty until then. */
export const placeNames = pgTable(
  'place_names',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    /** landmark | beach | park | reserve | natural | neighborhood | water */
    kind: text('kind').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    country: text('country').notNull().default(''),
    /** Other names the place goes by, lower case, between bars: "|tour eiffel|eiffel tower|". Kept for the kinds a person would name. */
    alt: text('alt'),
  },
  (t) => [index('place_names_at_idx').on(t.lat, t.lng), index('place_names_name_idx').on(sql`lower(${t.name})`)],
);

/**
 * Where a picture with no location might have been taken. source: vision (a worker's model recognised the place) or
 * nearby (kept only as a "no": those suggestions are worked out fresh). status: open | rejected.
 */
export const placeSuggestions = pgTable(
  'place_suggestions',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    name: text('name').notNull().default(''),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    confidence: real('confidence').notNull().default(0),
    why: text('why').notNull().default(''),
    fromItem: uuid('from_item'),
    model: text('model'),
    status: text('status').notNull().default('open'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.source] })],
);

/** A machine of the owner's that reads the pictures. It signs in with a token; only the token's hash is kept. */
export const workers = pgTable('workers', {
  id: id(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  paused: boolean('paused').notNull().default(false),
  /** What the machine last said about itself: host, os, gpu, what it is doing, its models. */
  info: jsonb('info').$type<Record<string, unknown>>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * One row per item per task (caption, embed, faces, place): where that piece of work stands and which model did it.
 * A claim is a lease. When it runs out the task goes back in line.
 */
export const aiTasks = pgTable(
  'ai_tasks',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    task: text('task').notNull(),
    /** queued | claimed | done | failed */
    status: text('status').notNull().default('queued'),
    workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    /** The model that produced the result now stored, so a better one can redo the library later. */
    model: text('model'),
    modelVersion: text('model_version'),
    error: text('error'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.task] }), index('ai_tasks_status_idx').on(t.status, t.task), index('ai_tasks_worker_idx').on(t.workerId)],
);

export const activity = pgTable(
  'activity',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    who: text('who').notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('activity_created_idx').on(t.createdAt)],
);

/** Work that happens after an upload returns: making the WebP copies, rendering an edited copy. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(), // ingest | render
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull().default({}),
    /** queued | running | done | failed */
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    locked: boolean('locked').notNull().default(false),
  },
  (t) => [index('jobs_status_idx').on(t.status, t.createdAt)],
);
