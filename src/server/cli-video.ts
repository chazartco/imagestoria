/**
 * Line up playable copies for the videos already in the library: every video that has not been looked at yet,
 * and every one whose copy failed. The running app does the work, one video at a time, after everything else.
 *
 *   npm run video:copies
 *   docker compose exec app npm run video:copies
 */
import { loadConfig } from './config.js';
import type { Ctx } from './context.js';
import { openDb } from './db/index.js';
import { queueMissingPlayCopies } from './media/playcopy.js';

const cfg = loadConfig();
if (cfg.VIDEO_COPY === 'never') { console.error('Video copies are turned off (VIDEO_COPY=never). Set it to auto or always first.'); process.exit(2); }
const { db, pool } = await openDb(cfg.DATABASE_URL);
try {
  const n = await queueMissingPlayCopies({ cfg, db, kick: () => {} } as unknown as Ctx);
  console.log(n ? `${n} ${n === 1 ? 'video is' : 'videos are'} in line. The app looks at each one and makes a copy where one is needed.` : 'Every video has been looked at already. There is nothing to do.');
} finally { await pool.end(); }
