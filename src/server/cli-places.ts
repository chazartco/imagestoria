/**
 * Place names finer than towns: beaches, parks, landmarks, neighbourhoods. They come from GeoNames (geonames.org, CC BY 4.0).
 *
 *   npm run places                     fetch the list (about 400 MB), keep what is useful, name every located item again
 *   npm run places -- /path/to/allCountries.zip     the same, from a file you already have (the zip or the text file)
 *   npm run places -- rename           name every located item again from the data already loaded
 *   docker compose exec app npm run places
 */
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { openDb, prepareDb } from './db/index.js';
import { importPlaceNames, placeDataState, renameAll } from './media/spots.js';

const cfg = loadConfig();
const { db, pool } = await openDb(cfg.DATABASE_URL);
const ctx = { cfg, db, log: console, kick: () => {} } as unknown as Ctx;
const arg = process.argv[2];
try {
  await prepareDb(db, pool, () => {});
  if (arg === 'rename') {
    const st = await placeDataState(ctx);
    if (!st.rows) { console.error('No place names are loaded yet. Run "npm run places" first.'); process.exitCode = 2; }
    else console.log(`${await renameAll(ctx)} items named again from ${st.rows.toLocaleString('en')} place names.`);
  } else {
    const r = await importPlaceNames(ctx, arg, (m) => console.log(m));
    console.log(`Done. ${r.kept.toLocaleString('en')} place names are loaded. Place names from GeoNames, geonames.org, CC BY 4.0.`);
  }
} catch (e) {
  console.error(`That did not work. ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally { await pool.end(); }
