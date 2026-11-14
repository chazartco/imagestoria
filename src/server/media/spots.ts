import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/index.js';
import { nearestPlace, searchPlaces } from './geo.js';

/**
 * Places finer than the nearest town: the beach, the park, the landmark, the neighbourhood.
 *
 * The names come from GeoNames (geonames.org, CC BY 4.0), which the operator fetches once: about 400 MB to download,
 * read straight from the zip, and about 1.3 million rows kept in the place_names table (roughly 400 MB in Postgres).
 * Nothing is asked of an outside service when a picture is named. Without the data everything works as before,
 * and a picture is filed under its nearest town only.
 */

export const GEONAMES_URL = 'https://download.geonames.org/export/dump/allCountries.zip';

/** GeoNames feature codes worth naming a picture after: what kind of place each is. Everything else in the file is left out. */
const KINDS: Record<string, string> = {
  MUS: 'landmark', MNMT: 'landmark', CSTL: 'landmark', HSTS: 'landmark', ANS: 'landmark', PAL: 'landmark', RUIN: 'landmark', TOWR: 'landmark', LTHSE: 'landmark',
  PIER: 'landmark', SQR: 'landmark', ZOO: 'landmark', STDM: 'landmark', AMTH: 'landmark', ARCH: 'landmark', PYR: 'landmark', PYRS: 'landmark', OBS: 'landmark', THTR: 'landmark', MKT: 'landmark',
  BCH: 'beach', BCHS: 'beach', COVE: 'beach',
  PRK: 'park', GDN: 'park', AMUS: 'park', RESN: 'reserve', RESW: 'reserve', RESF: 'reserve',
  ISL: 'natural', ISLS: 'natural', ISLET: 'natural', CAPE: 'natural', PT: 'natural', FLLS: 'natural', PK: 'natural', VLC: 'natural', CNYN: 'natural', PASS: 'natural', RK: 'natural', CAVE: 'natural', GLCR: 'natural',
  PPLX: 'neighborhood',
  BAY: 'water', LK: 'water', LGN: 'water', HBR: 'water',
};
const CLASS_OF = new Set(['S', 'T', 'L', 'H', 'P']);
const NAMED = new Set(['landmark', 'beach', 'park', 'reserve', 'natural']);
/**
 * How close a picture must be to be named after a place of each kind, in metres, in the order they are tried.
 * A landmark has to be right there. A bay or a mountain is large, its one point on the map says little, so it is tried last.
 */
export const REACH: [string, number][] = [['landmark', 150], ['beach', 400], ['park', 300], ['natural', 500], ['reserve', 1000], ['neighborhood', 1500], ['water', 2000]];

const metres = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
};

export interface Spot { name: string; kind: string; metres: number }
/** The finest named place at a point, or nothing when there is none in reach or no place data has been fetched. */
export async function spotFor(ctx: Ctx, lat: number | null, lng: number | null): Promise<Spot | null> {
  if (lat == null || lng == null) return null;
  const dLat = 2000 / 111320, dLng = dLat / Math.max(0.05, Math.cos(lat * Math.PI / 180));
  const rows = await ctx.db.execute(sql`select name, kind, lat, lng from place_names where lat between ${lat - dLat} and ${lat + dLat} and lng between ${lng - dLng} and ${lng + dLng}`);
  let best: Spot | null = null;
  for (const [kind, reach] of REACH) {
    for (const r of rows.rows as { name: string; kind: string; lat: number; lng: number }[]) {
      if (r.kind !== kind) continue;
      const m = metres(lat, lng, r.lat, r.lng);
      if (m <= reach && (!best || m < best.metres)) best = { name: r.name, kind, metres: Math.round(m) };
    }
    if (best) return best;
  }
  return null;
}

/** The town row for a point, made if this is the first picture from there. */
export async function placeIdFor(ctx: Ctx, lat: number | null, lng: number | null): Promise<string | null> {
  if (lat == null || lng == null) return null;
  const hit = nearestPlace(lat, lng);
  if (!hit) return null;
  const { places } = schema, same = and(eq(places.name, hit.name), eq(places.region, hit.region), eq(places.country, hit.country));
  const found = await ctx.db.select({ id: places.id }).from(places).where(same).limit(1);
  if (found[0]) return found[0].id;
  const made = await ctx.db.insert(places).values(hit).onConflictDoNothing().returning({ id: places.id });
  if (made[0]) return made[0].id;
  return (await ctx.db.select({ id: places.id }).from(places).where(same).limit(1))[0]?.id ?? null;
}

/** Everything a location gives an item: its town, and the finer place when there is one. */
export async function whereFor(ctx: Ctx, lat: number | null, lng: number | null) {
  const spot = await spotFor(ctx, lat, lng).catch(() => null);
  return { placeId: await placeIdFor(ctx, lat, lng), spot: spot?.name ?? null, spotKind: spot?.kind ?? null };
}

/* ---------- fetching and reading the data ---------- */

export interface PlaceDataState { rows: number; at: number | null; busy: string | null; error: string | null }
const state: { busy: string | null; error: string | null } = { busy: null, error: null };
export async function placeDataState(ctx: Ctx): Promise<PlaceDataState> {
  const [n] = (await ctx.db.execute(sql`select count(*)::int as n from place_names`)).rows as { n: number }[];
  const [s] = await ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'places:data'));
  return { rows: n?.n ?? 0, at: (s?.value as any)?.at ?? null, busy: state.busy, error: state.error };
}

/**
 * The lines of the one file inside a zip, without unpacking it to disk. A zip entry is a short header followed by
 * a deflate stream, and the stream knows where it ends, so nothing more of the format is needed.
 */
async function* zipLines(file: string): AsyncGenerator<string> {
  const fd = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(30);
    await fd.read(head, 0, 30, 0);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('That file is not a zip.');
    if (head.readUInt16LE(8) !== 8) throw new Error('That zip is packed in a way this reader does not know.');
    const start = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const inflate = zlib.createInflateRaw();
    fs.createReadStream(file, { start }).pipe(inflate);
    for await (const line of readline.createInterface({ input: inflate, crlfDelay: Infinity })) yield line;
  } finally { await fd.close(); }
}
async function* textLines(file: string): AsyncGenerator<string> {
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) yield line;
}

/**
 * Load place names from a GeoNames file (the zip as downloaded, or the text file inside it), or fetch it first.
 * The table is replaced in one go at the end, so a failed import leaves the old names in place.
 */
export async function importPlaceNames(ctx: Ctx, source?: string, say: (msg: string) => void = () => {}) {
  if (state.busy) throw new Error('Place data is already being fetched.');
  state.busy = 'Starting'; state.error = null;
  let fetched: string | null = null;
  try {
    let file = source;
    if (!file || /^https?:\/\//.test(file)) {
      const url = file || GEONAMES_URL;
      await fsp.mkdir(ctx.cfg.tmpDir, { recursive: true });
      fetched = file = path.join(ctx.cfg.tmpDir, 'place-names.zip');
      state.busy = 'Downloading the place names (about 400 MB)'; say(state.busy);
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}.`);
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(file));
    }
    const lines = /\.zip$/i.test(file) ? zipLines(file) : textLines(file);
    await ctx.db.execute(sql`create table if not exists place_names_new (like place_names including defaults)`);
    await ctx.db.execute(sql`truncate place_names_new`);
    let seen = 0, kept = 0, batch: any[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await ctx.db.execute(sql`insert into place_names_new (id, name, kind, lat, lng, country, alt) values ${sql.join(batch.map((b) => sql`(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]}, ${b[4]}, ${b[5]}, ${b[6]})`), sql`, `)} on conflict do nothing`);
      batch = [];
    };
    for await (const line of lines) {
      seen++;
      // geonameid, name, asciiname, alternatenames, latitude, longitude, feature class, feature code, country code, ...
      const c = line.split('\t');
      const kind = CLASS_OF.has(c[6] ?? '') ? KINDS[c[7] ?? ''] : undefined;
      if (!kind || !c[1]) continue;
      const id = Number(c[0]), lat = Number(c[4]), lng = Number(c[5]);
      if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // the other names a place goes by, for the kinds a person or a vision model would name: "Eiffel Tower" for "Tour Eiffel"
      const alt = NAMED.has(kind) && c[3] ? `|${[c[2] ?? '', ...c[3].split(',')].map((n) => n.trim().toLowerCase()).filter((n) => n && /^[ -~À-ɏ]+$/.test(n)).join('|').slice(0, 400)}|` : null;
      batch.push([id, c[1].slice(0, 200), kind, lat, lng, (c[8] ?? '').slice(0, 2), alt && alt.length > 2 ? alt : null]); kept++;
      if (batch.length >= 2000) { await flush(); if (kept % 100000 === 0) { state.busy = `Reading the place names: ${kept.toLocaleString('en')} kept so far`; say(state.busy); } }
    }
    await flush();
    if (kept < 1000 && seen > 100000) throw new Error('That file does not look like the GeoNames list of places.');
    if (!kept) throw new Error('No place names were found in that file.');
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`truncate place_names`);
      await tx.execute(sql`insert into place_names select * from place_names_new`);
      await tx.execute(sql`drop table place_names_new`);
      await tx.insert(schema.settings).values({ key: 'places:data', value: { at: Date.now(), rows: kept, source: 'GeoNames' } }).onConflictDoUpdate({ target: schema.settings.key, set: { value: { at: Date.now(), rows: kept, source: 'GeoNames' } } });
    });
    await ctx.db.execute(sql`analyze place_names`);
    say(`${kept.toLocaleString('en')} place names kept, out of ${seen.toLocaleString('en')} lines.`);
    state.busy = 'Naming the places of the pictures again';
    const n = await renameAll(ctx);
    say(`${n} items named again.`);
    return { kept, seen, renamed: n };
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    state.busy = null;
    if (fetched) await fsp.rm(fetched, { force: true });
    await ctx.db.execute(sql`drop table if exists place_names_new`).catch(() => {});
  }
}

/** Name the place of every located item again, for when the place data has changed. Locations themselves are not touched. */
export async function renameAll(ctx: Ctx) {
  const { items } = schema;
  const rows = await ctx.db.select({ id: items.id, lat: items.lat, lng: items.lng, spot: items.spot, spotKind: items.spotKind, placeId: items.placeId }).from(items).where(and(isNotNull(items.lat), isNotNull(items.lng)));
  let n = 0;
  for (const r of rows) {
    const w = await whereFor(ctx, r.lat, r.lng);
    if (w.spot === r.spot && w.spotKind === r.spotKind && w.placeId === r.placeId) continue;
    await ctx.db.update(items).set({ ...w, updatedAt: new Date() }).where(eq(items.id, r.id)); n++;
  }
  // an item that lost its location keeps no place name
  await ctx.db.update(items).set({ spot: null, spotKind: null }).where(and(isNull(items.lat), isNotNull(items.spot)));
  return n;
}

/* ---------- turning a place someone named into a point ---------- */

const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * "Eiffel Tower, Paris, France" as a point on the map, from the data held here. The last parts name the town, the first
 * part the place within it. Without a match for the first part the town itself is the answer, and is marked as such.
 */
export async function geocode(ctx: Ctx, text: string): Promise<{ lat: number; lng: number; name: string; exact: boolean } | null> {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  // every town that one of the later parts names: "Valencia" is a city in Spain and a city in Venezuela
  let towns: ReturnType<typeof searchPlaces> = [];
  for (let i = parts.length > 1 ? 1 : 0; i < parts.length && !towns.length; i++) {
    const rest = plain(parts.slice(i + 1).join(' '));
    towns = searchPlaces(parts[i]!, 12).filter((h) => plain(h.name) === plain(parts[i]!));
    // "Paris, France": of the towns called Paris, the ones in the country named after it
    const there = towns.filter((h) => rest && (rest.includes(plain(h.region)) || rest === plain(h.country)));
    if (there.length) towns = there;
  }
  const first = parts[0]!;
  let cands = (await ctx.db.execute(sql`select name, lat, lng from place_names where lower(name) = ${first.toLowerCase()} limit 300`)).rows as { name: string; lat: number; lng: number }[];
  // not under that name: perhaps under another one it goes by
  if (!cands.length && first.length >= 4) cands = (await ctx.db.execute(sql`select name, lat, lng from place_names where alt like ${'%|' + first.toLowerCase().replace(/[%_|\\]/g, '') + '|%'} limit 300`)).rows as typeof cands;
  // the place of that name closest to a town of that name, when they are near each other
  let best: { c: (typeof cands)[number]; m: number } | null = null;
  for (const c of cands) for (const t of towns) { const m = metres(t.lat, t.lng, c.lat, c.lng); if (m < 80000 && (!best || m < best.m)) best = { c, m }; }
  if (best) return { lat: best.c.lat, lng: best.c.lng, name: text, exact: true };
  if (cands.length === 1) return { lat: cands[0]!.lat, lng: cands[0]!.lng, name: text, exact: true };
  // Several towns of that name and nothing else to go on: the one nearest to where this library already has pictures.
  let town = towns[0];
  if (towns.length > 1) {
    const known = await ctx.db.select({ lat: schema.places.lat, lng: schema.places.lng }).from(schema.places);
    let near = 300000;
    for (const t of towns) for (const k of known) { const m = metres(t.lat, t.lng, k.lat, k.lng); if (m < near) { near = m; town = t; } }
  }
  if (town) return { lat: town.lat, lng: town.lng, name: text, exact: plain(first) === plain(town.name) };
  return null;
}
