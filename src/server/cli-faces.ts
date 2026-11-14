/**
 * Tidy the faces: one row for one face, and a person in a picture once.
 *
 *   npm run faces                      look at every picture, remove a face stored twice, and take the tag off a second
 *                                      face of the same person in one picture (it is still remembered as them)
 *   docker compose exec app npm run faces
 *
 * The site keeps to this rule by itself. This is for a library whose faces were read before the rule was there.
 */
import { eq } from 'drizzle-orm';
import { matchFaces, tidyFaces } from './ai/faces.js';
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { openDb, prepareDb, schema } from './db/index.js';

const cfg = loadConfig();
const { db, pool } = await openDb(cfg.DATABASE_URL);
const ctx = { cfg, db, log: console, kick: () => {} } as unknown as Ctx;
try {
  await prepareDb(db, pool, () => {});
  const r = await db.transaction(async (tx) => {
    const t = await tidyFaces(tx);
    for (const s of await tx.select({ id: schema.spaces.id }).from(schema.spaces).where(eq(schema.spaces.people, true))) await matchFaces(ctx, tx, s.id);
    return t;
  });
  console.log(r.items ? `${r.items} pictures tidied. ${r.same} faces that were stored twice are removed. ${r.apart} faces that shared a name with another face in the same picture are remembered as that person and carry no second tag.` : 'Nothing to tidy. Every face is stored once, and nobody is in a picture twice.');
} catch (e) {
  console.error(`That did not work. ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally { await pool.end(); }
