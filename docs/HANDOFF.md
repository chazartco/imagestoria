# Hand-off notes

For whoever takes this repository into production. Written at the end of Phase 2 (the standalone app).
Phase 1 was a single-file prototype that settled the look and behavior. Phase 3, reading the pictures on
machines of the owner's own, was added after that: see "Phase 3: reading the pictures" below. The iPhone
app that was planned with it is postponed.

## Where things stand

The app is complete for Phase 2 and its tests pass. It was built and tested in a sandbox that has no
Docker daemon and no route to outside hosts, so some things could only be tested against stand-ins and
a few could not be tested at all. This list is exact.

**Tested here**

- 113 server tests (`npm test`) against a real Postgres 16: setup, sign-in, sessions, invites, password
  resets, roles and per-person switches, uploads, duplicate detection, EXIF date, GPS and camera, place
  naming, sideways photos, HEIC, video (ffmpeg), display and thumbnail copies, edits rendered on the
  server, likes, comments, tags, bulk actions, stories, trash, spaces, the folder import command.
- OpenID Connect sign-in against a stand-in provider that behaves like SolPersona's endpoints
  (discovery, authorization code with PKCE S256, `client_secret_post`, userinfo): first person becomes
  owner, invited people matched by link, handle or verified email, strangers turned away, a forged
  callback rejected.
- S3 storage against a local S3 server (s3rver): originals and copies under a prefix, signed links,
  streaming through the app, edits rendered from an original that lives in the bucket, deletion.
- 31 browser checks (`npm run test:e2e`) in headless Chrome against the real server: setup screen,
  uploads through the page, the never-crop rule measured on every tile and every image element, viewer
  edits surviving a reload, search, the editor end to end with the original's bytes compared before and
  after, the map (MapLibre running under the page's content security policy), selection and bulk
  actions, stories, trash and restore, invite and join as a view-only person with the server refusing
  everything that role may not do, a phone-sized screen, sign-on only mode, and bucket mode.
- The contents of the Docker image, minus its operating system layer, were assembled by hand in a
  clean folder following the Dockerfile's steps (`npm ci`, `npm run build`, `npm prune --omit=dev`,
  keeping only `package.json`, `node_modules`, `dist` and `drizzle`) and run with
  `node dist/server/index.js`. It migrated an empty database, served the page, and processed a JPEG, a
  HEIC and an MP4 uploaded with curl.
- A library of 50,000 synthetic rows: the index is 34 MB of JSON, 1.7 MB gzipped, about 1.1 s to
  produce. In headless Chrome with software rendering, sign-in to first thumbnails took about 4 s,
  filtering 16 ms, laying out the grid 75 ms, with about 40 tiles in the page at any moment.

**Not tested, check these first**

1. **The Docker image has never been built, and the Compose stack has never been started.** The
   Compose file parses (`docker compose config`), and the steps inside the Dockerfile were rehearsed by
   hand as described above, but no container has run. Expect to fix small things. Likely spots: the
   `apt-get` layer (ffmpeg, tini), the `npm ci` step on a non-x64 machine (sharp and @node-rs/argon2
   download prebuilt binaries per architecture), ownership of `/data` when it is a bind mount (the
   container runs as user `node`, uid 1000), and the health check.
2. **Real SolPersona.** Only the stand-in was used. The code reads everything from
   `<OIDC_ISSUER>/.well-known/openid-configuration` and expects the claims `sub`, `name`,
   `preferred_username`, `email`, `email_verified` from the userinfo endpoint.
3. **Real DigitalOcean Spaces.** Only the local S3 server was used, with path-style addresses. Spaces
   uses the bucket name in the host name (`S3_FORCE_PATH_STYLE=false`, the default).
4. **Real iPhone files.** HEIC was tested with one generated HEIC file, decoded by `heic-convert`
   (libheif compiled to WebAssembly) because the prebuilt sharp has no HEVC decoder. It is slow: a
   12 MP HEIC took about 5 seconds to decode and convert in the sandbox. Live Photos arrive as a HEIC plus a MOV and are stored as two items.
   HDR and 10-bit HEIC were not tried.
5. **Live map tiles.** OpenFreeMap was unreachable from the sandbox. The map was tested with a local
   style. Pins, bundles and clustering do not depend on the tiles.
6. **Large real uploads.** Multi-gigabyte videos were not tried. An upload is one request, held on
   `/data/tmp` until it is stored.

A reasonable first session: build the image, start it, complete setup, upload twenty real iPhone photos
and one video, open the map, edit one, connect SolPersona, switch to Spaces, run the import command on
a small folder.

## Refinements after Phase 2

Built on a machine with Docker, against the same tests.

**Group A, looking at pictures**

- The viewer is a modal at 90% of the screen over the dimmed library, and full screen below 820 px.
  The details panel folds away with one button and the choice is kept in the browser
  (`afterimage.vwInfo`).
- The editor is a modal of the same size and in the same place as the viewer, so "Edit a copy" does
  not leave it. It does not close on a click outside, because that would throw away unsaved work.
- Every modal closes from an X in its top right corner: viewer, editor, story reader, story player,
  and the sheets. In the viewer that corner is the details panel, or the picture's bar when the
  panel is folded. The story reader lost its "All stories" button for this.
- The original opens inside the viewer's own frame (`Zoom` in `src/web/js/viewer.js`). There is no
  second overlay. A click or Z zooms in, a click, Z or Esc comes back. Dragging moves the picture.
  The wheel never shrinks it below the fitted size.
- A video starts playing when it is opened, with sound. If the browser refuses sound it starts
  silent and shows "Turn sound on". Volume and mute are kept in the browser (`afterimage.volume`,
  `afterimage.muted`). A silence the browser forced is not saved as a choice.
- The editor has the round magnifier too. It cuts its patch from the full-size file
  (`/api/files/:id/full?proxy=1`, loaded once per editing session), applies the same turn, flip,
  straighten and crop as the preview, and runs the patch through `src/shared/develop.js`. So that a
  patch gets the vignette of the whole picture, `develop` takes the place of the patch in the whole
  (`fw`, `fh`, `ox`, `oy`). Without them it behaves exactly as before. Clarity takes its soft copy
  from the preview's soft copy. Grain is drawn per pixel, so in the magnifier it has the right
  strength but not the same pattern as the saved copy.

Not tested: real phones and touch (the magnifier and zoom were driven with a mouse in headless
Chrome), real browsers refusing sound (the refusal was simulated), and very large originals in the
editor's magnifier (the largest tried was 2400 px wide).

**Group B, library housekeeping**

- **Location for many items.** "Location" in the bulk bar opens one dialog (`src/web/js/locate.js`):
  a map that takes a draggable pin, a search over town names, the places already in the library, typed
  coordinates, and the last five locations used (kept in the browser, `afterimage.recentLocs`). The
  viewer uses the same dialog for one item. The search is `GET /api/places/search?q=`, answered from
  the `all-the-cities` list in `src/server/media/geo.ts` with no outside service. Names that start
  with what was typed come first, then larger places. `POST /api/items/bulk` gained `locate`
  (`lat`, `lng`, `only: missing | all`, where `missing` is the default) and `unlocate`.
  `items.location_source` is `exif` or `manual`. Rows that had coordinates before were marked `exif`.
- **Dates for many items.** "Date" in the bulk bar (`src/web/js/dates.js`). `shiftdate` takes whole
  `minutes` and adds them to the wall-clock time in the database. `setdate` takes one `d`. A shift
  keeps `items.date_source` as it was, because a corrected camera date is still the camera's, and
  that is also what makes Undo exact: it is the opposite shift. Set marks the items `manual`.
  `date_source` is `exif`, `file` or `manual`, written during processing from now on. Rows older than
  the column are empty and were not guessed. The quick filter "Date not from the camera" shows `file`.
  **Storage paths keep the year and month they were given at upload. Changing a date moves no file.**
- **Spaces.** Owners add a space from the "+" beside the tabs. `POST /api/spaces/order` takes the
  space ids in the order wanted and writes `spaces.position`. A new space goes last. The tab strip
  scrolls sideways when the tabs do not fit, and `#app` has one `minmax(0, 1fr)` column so that a
  wide header can never widen the page.
- **Email.** `src/server/mail.ts` holds a `Mailer` interface with one implementation, Resend's REST
  API called with `fetch` (no SDK). `ctx.mail` is what the routes use, and the tests replace it with
  one that talks to a stand-in. `send` never throws: it returns `{ ok: false, error }` with a sentence
  for the owner. Invite and link routes answer with `mail: { sent, to, error? }`, or `mail: null` when
  nothing was tried. Resend needs a `User-Agent` header and answers 403 without one. The key is read
  from settings, put in one header, and never logged. `RESEND_API_KEY` without a usable `MAIL_FROM`
  stops the server at start with a sentence saying so.
- **Trash.** A view of its own (`src/web/js/trash.js`, `go('trash')`), owners only. `GET /api/trash`
  returns what the rows need, including `twin` for an item whose file is already back in the library.
  `POST /api/trash/restore` and `/api/trash/empty` take an optional `ids`. The file route serves
  `thumb` and `display` of a trashed item to owners and answers 404 to everyone else and for every
  other kind. `TRASH_DAYS` starts a pass one minute after start and then daily
  (`src/server/trash.ts`). It is a timer inside the app process, so with two app containers both
  run it, which is harmless: removing a file or a row twice does nothing.

Not tested in group B: a real Resend account (the HTTP call was checked against Resend's published
API description and a stand-in, so run `npm run mail:test` once with a real key), real map tiles in
the location dialog (the test style has no tiles), dragging spaces by touch (the arrows work
everywhere), and the daily trash timer itself (the removal it calls is tested).

**Group C, stories**

- **Covers.** `stories.cover_ids` holds one to four item ids in the order the author clicked them.
  `cover_item_id` is kept as the first of them. A story made before this has an empty list and falls
  back to `cover_item_id`. `GET /api/stories` returns `covers` with anything in the trash left out,
  so a deleted cover picture drops out and comes back if it is restored. The reader has a "Choose
  cover" mode. The card and the story header lay the pictures out whole: `Stories.coverRows` tries
  one justified row and every split into two, and keeps the one that shows the pictures largest.
- **Sections.** A story with no rows in `story_sections` arranges itself by date, exactly as before,
  with its notes in `stories.notes` keyed by date. The first change made by hand (a break, a move, a
  section title) turns the parts on screen into sections that carry their heading and their text.
  From then on `story_items.section_id` and `story_items.position` hold the author's order.
  The page always sends the whole arrangement (`PATCH /api/stories/:id` with `sections`), and the
  server replaces the rows in one transaction, so there are no section ids for the page to track.
  `sections: null` goes back to automatic: the sections are removed and `stories.notes` is still
  there. Removing a break joins a section to the one before and keeps both texts. A section left
  empty by a move is removed the same way.
- **Pictures in the trash and sections.** The page cannot see trashed pictures, so an arrangement
  sent while one is in the trash leaves it out. The server keeps it at the end of the last section,
  where it reappears if it is restored. A section whose every picture is in the trash is not shown,
  and its text is dropped the next time the arrangement is saved.
- **Arranging.** "Arrange" in the reader shows each section as small uncropped pictures. Dragging
  moves a picture, the line between two pictures starts a section there, and Shift with the left or
  right arrow moves the focused picture one step, which is the way to do it without a mouse.
- **Taking pictures out.** In "Arrange", the small x on a picture (or Delete on the focused one)
  removes it from the story, and "Remove section" removes a section with its pictures after a
  confirmation. The items stay in the library. `PATCH /api/stories/:id` takes `remove` (item ids)
  and `add` (item ids of the same space, which is how the page's Undo puts them back). A picture
  that leaves the story leaves its cover. A story keeps at least one picture: removing the last
  one is refused, and the story is deleted instead. Removing does not turn an automatic story into
  a manual one.
- **Player.** It follows the author's order and shows a section's title for a moment as the section
  begins. A video plays from start to end and then the player moves on. Its piece of the progress
  bar is driven by the video's own clock, so pausing or waiting for data never puts it out of step.
  Sound follows the viewer's remembered volume (`playWithSound` in `viewer.js`, shared by both).
  A file the browser cannot play is shown as its still for as long as a photo.

Not tested in group C: dragging by touch, and dragging a picture to a spot that is off screen (the
browser's own scrolling while dragging does that, and headless Chrome could not be made to do it).
Video in the player was tried with one short H.264 clip.

**Stories, sharing, music and reels**

- **Settings is a modal.** `go('admin')` opens it over whatever is on screen (`Admin.open`). It opens
  on "Loading" every time, because showing last time's contents and then redrawing wiped whatever was
  being typed.
- **The slideshow.** The picture fills the screen up to 2% from each edge over an enlarged, blurred
  copy of itself at 40% (`#plBg`, the thumbnail). Caption, date and controls sit on one panel at the
  bottom right.
- **Making a story.** `StoryPicker` (`src/web/js/picker.js`) chooses pictures for a new story or adds
  to one that exists: everything, by place, by day, or by moment. A moment is a run of pictures with
  no gap longer than three hours, in one place. `PATCH /api/stories/:id` with `add` puts items in.
  A picture can be in any number of stories (`story_items` is keyed by story and item).
- **Groups.** `stories.groups` is a list of names. A name that is already in use keeps its spelling.
- **Who may do what.** Owners and editors of a space read and change every story in it. So does
  whoever made a story, while they may still edit. Anyone else reads a story only when they are
  ticked in its Share sheet (`stories.shared_with`), and never changes it.
  `GET /api/stories/:id/access` lists the people and the links for the Share sheet.
- **Public links.** `story_links`, managed with `POST /api/stories/:id/links`,
  `PATCH` and `DELETE /api/story-links/:id`. The token is stored as written so the link can be copied
  again later, which means a leaked database would open the shared stories. `/s/<token>` serves the
  normal page, which sees the address and runs `Share.boot` instead of the app: the reader and the
  slideshow, read-only, fed by `GET /api/share/:token`. That answer is built from the story's own
  items only, with no tags, descriptions, comments, camera details or exact coordinates, and a file
  name only when downloads are allowed. `/api/share/:token/files/:id/:kind` serves `thumb` and
  `display`, a video's file so it can play, and a photo's original only with `allowDownload`.
  A password is an Argon2 hash. After it is typed the visitor holds a cookie that is a hash of the
  token and the password hash, so it stops working when the password changes. With `allowAdd`,
  `POST /api/share/:token/upload` makes a normal item in the story's space with no `added_by`,
  limited to 200 an hour per address. The owner sees how often each link was opened.
- **Music.** Two files. `src/server/media/synth.ts` is the sound engine: band-limited oscillators
  with unison, zero-delay state-variable filters, an FM electric piano and bass, modal mallets, a
  drum machine (tuned kicks, layered snares and claps, six-oscillator metallic cymbals), chorus,
  tape wobble, a tempo delay, and a feedback-delay-network reverb. Its `Mix` class sets each group of
  instruments to a level, ducks groups under the kick, and masters the result (glue compression,
  slow level riding, loudness to a LUFS target, soft clip, look-ahead limiter). `music.ts` is the
  music: for each of the ten pieces its chords, bass line, drum patterns and a melody written out
  note by note, over the same 36-bar shape. A piece renders in four to nine seconds.
  The first version used plucked-string models and a comb reverb and sounded thin and metallic.
  Do not go back to either. The page asks for music with `?v=<MUSIC_VERSION>` so a browser never
  plays a cached copy of an older version.
  `routes/music.ts` renders a piece the first time it is asked for, encodes it to AAC with ffmpeg,
  keeps it under `music/builtin/v<N>/`, and notes that in the `settings` table. Raise `VERSION` there
  when the pieces change. Uploaded tracks are rows in `music_tracks` and files under `music/uploads/`.
  A track is named by one string: `builtin:<name>` or a `music_tracks` id.
- **Reels.** `src/server/media/reel.ts`, run as a `reel` job. Each photo becomes one composed frame
  (sharp) held for a few seconds. Each video is scaled into the same frame with ffmpeg and keeps its
  sound. The pieces are joined with the concat demuxer, then the music is laid under with a sidechain
  compressor keyed by the videos' own sound, which is what makes it dip. Output is H.264, 30 frames a
  second, AAC, 1080 by 1920 or 1920 by 1080, with the index at the front. `renderReel` never throws:
  a reel that cannot be made is marked `failed` with a sentence. Working files live in
  `/data/tmp/reel-<id>` and are always removed.

Not tested here: how the music sounds (it was checked by measurement only: loudness in LUFS, balance
across eight frequency bands, true peak, no clipping, a seamless loop, every melody bar the right length), a real phone opening a public link, public links
with files in a bucket, HDR or 10-bit video in a reel (they will look washed out until group E's
conversion exists), and a reel of more than a handful of items.

**Group D, looks**

- **The pipeline.** `src/shared/develop.js` now has two versions. `develop` is version 1 and is not to
  be touched: a copy saved before group D has no `v` in its recipe and renders through it, pixel for
  pixel as before (a test holds a digest of its output). `develop2` is version 2. It adds a curve each
  for red, green and blue, color mixing in eight hue ranges (hue, saturation, brightness), a midtone
  tint and a balance next to the old shadow and highlight tints, a matte control, a 3D lookup table
  with tetrahedral interpolation, and an intensity that blends everything against the untouched
  picture. With only the old controls in use version 2 comes out within two levels of version 1, so
  reopening an old copy in the editor changes nothing you can see. `developRecipe` picks the version.
- **Order inside version 2:** clarity, exposure and white balance, contrast, tone regions, curves, color
  mixer, vibrance and saturation, the three tints, the lookup table, matte, fade, vignette, grain,
  intensity. The mixer comes before saturation on purpose: with saturation at -100 it works as a
  colored filter for black and white.
- **Speed**, 12 megapixels, in this sandbox: version 1 with a typical look 557 ms; version 2 with the
  same settings 527 ms; with every new control 720 ms; with every new control and a 33-point table
  1055 ms.
- **The looks.** 78 of them in eleven groups, in `src/shared/looks.js`. They are recipes written for
  this app. None is copied from or named after a preset pack, a film stock, a brand or a person, and
  that must stay so. `npx tsx scripts/contact-sheet.mts [folder of photos] [output folder]` prints
  every look on the same six pictures, one page per group. Without a folder it draws six practice
  scenes (faces, sea and sky, leaves, a night street, a low sun, a color chart). The looks have so far
  been tuned only against those drawn scenes, not against real photographs.
- **The Looks tab.** Groups fold (remembered), previews are drawn only when they scroll into view,
  there is a search box, an intensity slider, a star on each look for favorites, and a recently used
  group. Favorites, recent looks and folded groups live in the browser's local storage, so they do not
  follow a person to another device. Resting the mouse on a look shows it on the main picture.
- **Looks of your own.** `.cube` files with a 3D table of up to 65 points a side, one list for the whole
  library (`luts` table, `src/server/routes/luts.ts`, parser in `src/server/media/cube.ts`). The file is
  checked on upload and kept as raw 32-bit numbers at `luts/<id>.f32`. A recipe names its table by id
  (`recipe.lut`). **Removing a look that a copy uses** takes it off the list and keeps the row
  (`removed_at`) and the numbers, so the copy can still be rendered and reopened. A look no copy uses
  is deleted outright. The numbers of a removed look are never cleaned up, even after the last copy
  that used it is gone; they are at most 3.3 MB each.

- **Favorites** take the built-in looks by name and looks of your own as `lut:<id>`.
- **A reel opens on the story's card**: the cover pictures, each whole, over a blurred copy of the
  first, with the title and a line of facts on a dark panel (`composeCard` in `media/reel.ts`). There is
  no fade in, so the first frame of the file is the card in full, which is what a site shows as the
  thumbnail. The card stays as long as a photo, and at least 2.5 seconds. The words are drawn by
  sharp from an SVG, which needs a font on the machine: the Docker image installs `fonts-dejavu-core`
  for this. Without any font the card has its pictures and no words.

Not tested here: the looks on real photographs, the Looks tab on a touch screen (there is no hover),
`.cube` files written by real grading programs (the tests write their own), and very large previews.

**Group E, video, backups and the phone**

- **A copy every browser can play** (`src/server/media/playcopy.ts`). Each video is looked at once with
  ffprobe and gets one of four answers: `none` (H.264, 8-bit 4:2:0, AAC or silent, in MP4 or MOV: it
  plays as it is), `remux` (only the container is wrong: repackaged without re-encoding), `audio`
  (the video is fine and the sound is not, which is what most cameras write: the video is copied and
  only the sound is made into AAC), or `encode` (anything else: a new H.264 MP4, same shape, long edge
  at most `VIDEO_COPY_MAX_EDGE`, upright, HDR tone-mapped with zscale and tonemap). The `audio` path is
  not in the original brief; it saves re-encoding 4K footage for the sake of its sound.
  The copy is at `video/{year}/{month}/{item id}.mp4`, its key, size, state and failure reason are on
  the item (`play_key`, `bytes_play`, `play_status`, `play_error`), and the file kind `play` serves it,
  or the original when there is none. The viewer and the story player use `play`. Download and reels
  use the original.
- **Its own lane in the queue** (`jobs.ts`, `claimCopy`). A `playcopy` job is taken only when no other
  job is waiting or running and no other copy is being made, in this container or another. A copy that
  fails is noted on the item and never marks the item itself as failed. There is one attempt. The
  button on the settings page and `npm run video:copies` line up every video not looked at yet and
  every one that failed.
- **ffmpeg is run** with `-nostdin`, `-protocol_whitelist file` (no network protocols), and a time
  limit (`VIDEO_COPY_TIMEOUT_MINUTES`, 180). Both the Docker image (ffmpeg 5.1) and the test machine
  (7.0) have libx264, aac, zscale and tonemap. That was checked, not assumed.
- **Disk while converting.** With local storage the original is first copied to `/data/tmp`, the copy
  is written beside it, and then stored. A 4 GB video therefore needs 4 GB for the working copy, plus
  the size of the new file twice for a moment (in tmp and in storage). A 1080p copy of a 4 GB 4K clip
  is usually under 1 GB, so about 6 GB free is enough, and 12 GB is the worst case (`VIDEO_COPY=always`
  on a file that does not shrink).
- **Backups** (`src/server/backup.ts`). One `pg_dump` in the custom format, to `backups/` in the app's
  own storage, the newest `BACKUP_KEEP` kept. `pg_dump` is in the app image, from the PostgreSQL
  project's repository (version 17), because Debian 12 only has 15 and the dump program must be the
  server's version or newer. It is in the app image and not in a sidecar because the backup has to be
  written through the app's own storage settings, encrypted with the app's passphrase, shown on the
  settings page, and guarded by a lock in the app's database: a sidecar would need all of those
  handed to it a second time. Encryption is the format `openssl enc -aes-256-cbc -pbkdf2 -iter 600000
  -md sha256` writes, so a backup can be opened without this app. It is not authenticated: a damaged
  file shows up as a failed `pg_restore`, not as a failed decryption. What has been made is kept in
  the `settings` table (`backup:list`, `backup:failure`), because storage has no way to list a folder.
  A Postgres advisory lock lets one backup run at a time across containers. The schedule is a time of
  day on the server's clock (the container's time zone, UTC unless `TZ` is set).
- **On a phone.** `manifest.webmanifest` and its icons are made by `scripts/build-web.mjs` from
  `brand/` (192, 512, a maskable 512, and a 180 px icon for iOS). There is no service worker and there
  must not be one that caches pictures or API answers. The page is drawn edge to edge and keeps clear
  of the notch and the home indicator through four CSS variables (`--sat`, `--sar`, `--sab`, `--sal`)
  set from `env(safe-area-inset-*)`. With a finger: hold a picture to start selecting and tap to add;
  in the viewer swipe sideways to step, down to close, and pinch to zoom on the same zoom layer the
  mouse uses.

- **Reels from the library, and the Reels page.** A reel no longer needs a story. Select pictures in the
  library, choose Make reel, and a sheet asks for a title (optional), up to four pictures for the card,
  the shape, the music and the pace. Such a reel has no `story_id`: it carries its `space_id`,
  `item_ids`, `title` and `cover_ids` itself, plays its pictures oldest first, and is stored under
  `reels/library/{space}/`. Whoever may see the space may watch it. Owners and editors of the space,
  and its maker while they may still edit, may delete it. `GET /api/reels?space=` lists every reel of a
  space a person may watch, from stories and from the library, and the Reels view (next to Stories)
  shows that list. Deleting a story takes its own reels with it and leaves library reels alone.
  Removing a space does not remove the files of its library reels from storage.

Not tested here, and needing a real phone: installing to the home screen on iOS and Android and how
the icon is cut; the real safe areas (the test sets the variables by hand); the feel of the gestures
(the tests send pointer events, not real fingers); the phone's own long-press menu on iOS; the photo
picker; a real iPhone HDR or Dolby Vision clip through the copy (the test makes its own PQ clip);
a scheduled backup firing at its time (the test checks the clock rule and runs backups by hand);
backups to a real bucket.

## Phase 3: reading the pictures

Built in five stages. The decisions it rests on: the worker runs on a machine with an NVIDIA GPU, on
Windows or Linux; face recognition offers both permissive models and the non-commercial InsightFace
packs as a config choice; people recognition is chosen per space and names are seen by the owner and
editors; search by meaning runs on the server's CPU; the worker fetches display copies, and originals
only for faces. The vision model, the scene list and the automatic naming threshold are settings.

### Stage 1: the door for workers

- **Tables.** `workers` (a machine, its token hash, pause, what it last said about itself) and `ai_tasks`
  (one row per item per task: `queued`, `claimed`, `done` or `failed`, the lease, the tries, and the
  model and version that produced the stored result). Migration `0008_workers`.
- **Tasks** are named in `src/server/ai/tasks.ts`: `caption`, `embed`, `faces`, `place`. `LIVE` lists the
  ones this server takes results for, and `APPLIES` says which items each applies to. Adding a task is a
  name, a condition and a function in `src/server/ai/results.ts`. Nothing else is redone.
- **`items.ai_status`** is kept by `syncAiStatus`: `done` once the caption task is done, `queued` while
  anything waits or is being read, `none` otherwise.
- **Routes** (`src/server/routes/worker.ts`). `POST /api/worker/claim`, `GET /api/worker/files/:id/:kind`,
  `POST /api/worker/results`, `POST /api/worker/heartbeat`. Requests under `/api/worker/` skip the
  `x-afterimage` rule and the cookie lookup in `app.ts`, and each route calls `needWorker`. A token is
  nobody on every other route.
- **One item, one worker.** `claimItems` locks the item rows with `FOR NO KEY UPDATE SKIP LOCKED` and
  passes over an item another worker holds. A claim is a lease of `AI_LEASE_MINUTES`. A heartbeat extends
  the leases the worker still holds. An expired lease is swept back to `queued` on the next claim, or to
  `failed` after `AI_MAX_ATTEMPTS`.
- **Results** are taken or refused one by one. A result needs the model's name and version. A result in
  the wrong shape is refused with a sentence and leaves the task with the worker.
- **Queueing.** `jobs.ts` queues an item when its ingest or its render (a saved copy) finishes. When the
  app starts, `queueTasks` adds any ready item that is not in line for a live task. Trashed items are not
  handed out or counted, and emptying the trash removes their rows.
- **Settings page.** A Workers section: per task what is waiting, being read, done and failed, with
  "Read everything again"; per machine a lamp, what it is, when it checked in, Pause and Revoke; and
  "Make a token", shown once.

Verified: `test/worker.test.ts` drives the whole cycle with a fake worker (`FakeWorker` in
`test/helpers.ts`), including two workers claiming at once, an expired lease, three failed tries, a
refused shape, pause, read again, trash, a saved copy and a revoked token, and checks that a token is
refused on thirteen other routes for reading and five for changing. `test/s3.test.ts` checks that a
worker gets signed bucket links. The browser test makes a token, sees it once, and pauses and revokes.

Not verified: many workers under real load. Two were tried at once.

### Stage 2: captions, scenes and objects

- **`worker/`** is a Python program (3.11 or newer, installed with `uv` by `install.sh` or `install.ps1`).
  `afterimage_worker/loop.py` is the loop, `site.py` talks to the site, `vision.py` talks to the model
  server, `bench.py` is the model bench. Its README covers setup, behaviour and licences.
- **The vision model** is reached through an OpenAI-compatible endpoint (`/chat/completions` with a
  `json_schema` response format). One request per picture returns a caption, one scene from
  `src/shared/scenes.js`, up to 12 objects with a confidence, and readable text. The answer is checked
  and asked for once more when it is not usable. The site sends the scene list in the heartbeat, so the
  list lives in one place.
- **Thinking is off and answers are capped.** On the real library Gemma 4 sometimes spent 8,000 tokens
  thinking and answered nothing, and on a menu it repeated blank lines until it ran out of room. The
  worker now sends `reasoning_effort: "none"` (from `[vision.extra]` in the config), caps the answer at
  700 tokens, and mends a JSON answer that was cut off. That took a picture from about 4.5 s to 1.8 s.
- **Corrections** (`PATCH /api/items/:id/ai`). `items.ai_locked` lists what a person set (`caption`,
  `scene`). `item_labels.source` is `ai` or `person`, and `removed` marks a label a person took off.
  `caption` in `src/server/ai/results.ts` leaves all of those alone on a second reading. A scene that is
  not on the list is filed under `other`.
- **Blue and amber.** In the viewer the caption has a blue rule and "Written by the worker", or an amber
  rule and "Corrected by a person". Chips are blue for the machine and amber for a person.
- **Videos** are read from the poster frame. The worker README says what better handling would need.

Choices:

- **The vision model: `qwen3.5:9b-q4_K_M`**, chosen after reading the bench page side by side.
  `gemma4:12b-it-q4_K_M` is twice as fast, but Qwen's descriptions were better and it named the
  subjects right more often. It is the default in `worker.example.toml` and the recommended setup in
  the worker README.
- **The scene list** (28 names): beach, coast, mountains, forest, desert, lake or river, countryside,
  park or garden, city street, architecture, landmark, interior, food and drink, portrait, group of
  people, celebration, sport, pets, wildlife, vehicle, night, sunset or sunrise, snow, underwater, art,
  document, object, other.

Verified: 17 worker tests against a stand-in site and model server (retry on a bad answer, backoff
without spinning, no claim while the model server is away, give-back on a mid-batch failure, working
hours, pause, a signed link fetched without the token). The browser test posts results and checks the
Scenes and In the picture filters, search over captions and over text in the picture, the viewer
panel, "More like this", the story draft button, and every kind of correction surviving a second
reading. A real library of about 1,100 items was captioned by the real worker.

Not verified: llama.cpp server and vLLM (only Ollama 0.40.16 was run). ARM machines: the worker is
plain Python and should run, but ONNX Runtime with CUDA on ARM was not tried. Quiet hours were tested
with a fake clock only.

### Stage 3: search by meaning, and near duplicates

- **pgvector or plain arrays: plain arrays.** The trade: pgvector answers from an index and uses no
  application memory, but it needs a different Postgres image (the library's volume was made by
  `postgres:16-alpine`), a change to the test setup, and an extension to keep in step. At tens of
  thousands of items a scan in memory is a few milliseconds. So embeddings are stored exactly in
  `item_embeddings` (bytea, 4 bytes a number) and held in memory as one byte a number (`EmbedIndex` in
  `src/server/ai/embed.ts`): 768 bytes an item, about 23 MB for 30,000 items. It catches up with the
  database before each use, reading only what is new. Revisit at a few hundred thousand items.
- **The model: SigLIP 2 base** (`onnx-community/siglip2-base-patch16-224-ONNX`, Apache 2.0, 768
  numbers). The worker runs the image half with ONNX Runtime on the GPU (`worker/afterimage_worker/embed.py`).
  The server runs the text half with `@huggingface/transformers` on the CPU. Text is lower-cased and
  padded to 64 tokens, as the model was trained. A result from a different model is refused with a sentence.
- **Search.** `GET /api/search?q=&space=`. The page keeps its instant filter and adds a "By meaning"
  block under it (`Meaning` in `library.js`), never listing a picture twice.
- **"More like this"** (`GET /api/items/:id/similar`) replaces the scene-and-label guess when embeddings
  exist. An edited copy and its original are never offered to each other.
- **Near duplicates** (`GET /api/duplicates?space=`). See `EmbedIndex.duplicates`: a burst is grouped by
  likeness to the first picture of the group, not to the neighbour, so a long sequence does not chain
  into one group. Edited copies are left out. The quick filter shows each group with the best one
  marked, and "Keep the best, trash the other N" moves the rest to the trash after a confirmation.
- **If the text model is too heavy:** set `EMBED_TEXT=false`. The fallback of asking a connected worker
  for the text embedding was not built, because the measurement below says the server can carry it.

Verified: `test/search.test.ts` (shape and model checks, ranking, spaces and permissions, off, failed,
copies, duplicates, trash and restore, no embedding in any answer). The browser test covers "By
meaning" under exact matches, More like this, and the duplicates filter with keep-the-best. The real
library was embedded and the cut-offs were set from it.

Not verified: search by meaning in the browser against the real text model. The real model was
measured from a script and the page was tested with a stand-in. The owner should type a few searches.

### Stage 4: people

- **Tables.** `persons` (per space), `faces` (box as fractions, embedding, quality, status, person,
  suggestion), `face_rejections`. `spaces.people` is the per-space switch.
- **Statuses:** `unsorted`, `suggested`, `confirmed` (a person said so), `auto` (named without asking),
  `ignored`, `notface`.
- **Grouping** is leader clustering by likeness, best faces first (`cluster` in `src/server/ai/faces.ts`).
- **References.** Only confirmed faces count as evidence. An automatic name never becomes evidence for
  the next one. A person's confirmed faces are clustered into looks and up to 8 faces of each look are
  kept as references, so a child at three and at thirteen is one person with two looks.
- **Automatic naming** needs: the switch on, at least `FACE_AUTO_MIN_CONFIRMED` confirmed faces, a
  likeness at or above the threshold plus `FACE_STRICT_STEP` for every undo of that person, and a lead
  of `FACE_GAP` over the next person. It is off until the owner turns it on.
- **The numbers** (`GET /api/faces/numbers`) take each confirmed face out in turn and name it again from
  the rest, at eight thresholds. The People page shows the table above the switch.
- **Two places** (`src/web/js/people.js`). The People tab (`People`) shows a card for each named person and
  that person's pictures when one is chosen. Saying who is who (`Naming`) is three cards under "People
  in the pictures" on People and settings, for the space the owner is in: Name faces, Automatic naming
  and People recognition. Name faces opens a workspace with a tab for each kind of work: questions,
  faces to name, names given automatically, and the people there are. Faces seen once are chosen by
  clicking, any number of them (shift and click takes a run), and named or set aside together. That
  page is the owner's, so an editor names people from the chips in the viewer. Profile pictures are
  also set only on that page, from the person's own card, so for now only an owner can have one: the
  routes allow anyone, the page does not offer it.
- **One face is one row, and a person is in a picture once** (`tidyFaces` in `src/server/ai/faces.ts`). Two
  boxes on the same spot are one face found twice, and the weaker row is deleted, on arrival and after
  naming or merging. A second, separate face named as someone already tagged in the picture gets the
  status `also`: it carries no tag, it is not asked about again, and who it is stays in `suggested_id`.
  The tag stays on the face that had it. Without this the two faces took the name from each other in
  turn and both kept coming back to be named. Matching never offers someone already named in the
  picture. `npm run faces` applies the rule to a library read before it existed. There is no page yet
  that lists the `also` faces or lets one be changed back, other than naming it as someone else through
  the database.
- **People and settings is a board of cards** (`src/web/js/admin.js`). Every person, every space and
  every part of the server (backups, workers, places, video, storage, trash, sign-in, email, recent
  activity) is a card with the one fact worth knowing and a lamp. A card opens a window over the page
  with the details and the controls. `Admin.modal` holds which window is open ("backup",
  "person:<id>"), so the redraw after a change puts the same window back. `Admin.M` has one function
  per window. Space cards drag into the order of the tabs. The whole board fits one screen at
  1440 by 900, and a browser check holds it to that.
- **Who sees what.** `seesPeople` in `src/server/routes/faces.ts`: owner and editors. `/api/index` adds
  `people` to an item and `persons` to the answer only for the spaces where the person may see them.
- **A face thumbnail is a detail of a picture**, cut by the server with room around it, in the shape of
  the face's own box, with square corners. This is the one place something is shown cut, and it is a
  deliberate reading of the "nothing is cropped" rule: the picture itself is never shown cropped. Say
  so if it should be done another way.
- **Deleting.** Face rows go with the item (cascade). Forgetting a person deletes their faces' data.
  Turning a space off deletes its faces, people, answers and waiting work. "Turn off everywhere" does
  that for every space. Moving an item to another space leaves its names behind.
- **Models.** The worker's default is YuNet and AuraFace v1 (MIT and Apache 2.0). `models = "insightface"`
  uses buffalo_l, which is for non-commercial research only. The licence wording is in the worker README.

Verified: `test/people.test.ts` (ten tests: off by default, permissions, grouping, naming, suggestions,
rejections, the numbers, automatic naming with gap and minimum, undo and strictness, looks, reading
again, merge, rename, forget, move, off, wipe, and no embedding in any answer). The browser test names
a group, answers a suggestion with the Y key, checks the library filter, search, the viewer chips and
outline, an automatic name and its undo, and the wipe. A real space of about 1,050 photos was read by the real worker.

Not verified: the InsightFace path. It is written from the package's documented interface and was not
installed or run. Nobody has named a real person yet, so the real-library numbers table is empty
until the owner does. The thresholds for AuraFace are set from the spread of likenesses seen on the
real library, not from confirmed names.

### Stage 5: places beyond GPS

- **Place data: GeoNames.** Compared with Overture (12 GB for places, business listings, releases
  deleted after 60 days), Who's On First (8.6 GB, neighbourhoods only) and an OpenStreetMap extract (the
  densest, but 89 GB to download and a build pipeline). GeoNames is one 403 MB file under CC BY 4.0
  with every kind wanted. Its weakness is density: about 63,000 beaches and 93,000 parks worldwide.
- **Import** (`src/server/media/spots.ts`): reads the zip without unpacking it, keeps 1.3 million of 13.5
  million lines, about 270 MB in Postgres, in about a minute. `place_names` is replaced in one go.
- **Naming** (`spotFor`): the nearest place of each kind within its reach, tried in order: landmark
  150 m, beach 400 m, park 300 m, natural feature 500 m, reserve 1 km, neighbourhood 1.5 km, water 2 km.
  Stored as `items.spot` and `items.spot_kind`, beside the town. A lookup is about a millisecond with a
  plain index on latitude and longitude. No PostGIS.
- **Suggestions** (`src/server/routes/places.ts`). "nearby" is worked out fresh from pictures the same
  camera took within `PLACE_NEARBY_MINUTES`, and only from locations a camera or a person set, never from
  an accepted suggestion. "vision" comes from the worker's `place` task and is looked up on the map held
  here (`geocode`), under the place's other names too. Accepting sets `location_source = 'suggested'`.
- **Re-running:** "Name places again" on the settings page, `npm run places -- rename`, and every import.

Verified: `test/places.test.ts` (import from text and from a zip, kinds kept and left out, reach and
order, rename, geocoding, nearby and vision suggestions, accept, reject, no location stored before
acceptance). The browser test covers the settings section, the filter, search, the viewer, the review
sheet on "No location", and a rejection in the viewer. The real file was imported into the real
library.

Not verified: the "Fetch the place names" button against geonames.org from inside the app container.
The same function was run from the command line with a file. The `place` task has run on the real
library's five unlocated pictures only if the worker got to them: see "What was measured".


### What was measured

All of this was run in November 2026 on one machine with a 16 GB NVIDIA card (Windows 11, WSL2 Ubuntu
24.04, Ollama 0.40.16 in Docker) against a real library of about 1,100 items.

**The vision model bench.** 200 photos, spread across the library by date, each shown to every model
at 1024 px with thinking off. The page with every answer side by side is not in the repository,
because it holds the pictures. The command to make one of your own is in the worker README.

| Model | Seconds a picture | Read | Failed | Licence |
|---|---|---|---|---|
| `gemma4:12b-it-q4_K_M` | 1.8 | 200 | 0 | Apache 2.0 |
| `qwen3.5:9b-q4_K_M` | 3.4 | 200 | 0 | Apache 2.0 |
| `bonsai-2:27b` | 4.3 | 200 | 0 | Apache 2.0 |
| `qwen3-vl:8b` | 11.9 | 12 | 188 | Apache 2.0 |

`qwen3-vl:8b` gave no JSON for 179 pictures: it appears to keep thinking whatever it is told and runs into
the 700 token limit. It may do better with a larger limit, at a speed nobody would want. Gemma 4 is the
fastest. Qwen 3.5 was chosen for better descriptions and for naming the subjects right more often.
The GPU memory column on the page is not to be trusted from this run: other programs already held
about 12 GB when it started.

**The library run.** Every item was captioned and embedded by the real worker with
`gemma4:12b-it-q4_K_M`, about 2 seconds an item for both together once thinking was off. None failed.
The captions were then read again with `qwen3.5:9b-q4_K_M` at about 3.4 seconds each.
Before thinking was turned off, 3 pictures in the first 20 failed three times each at about 80 seconds a try.

**Search by meaning.** The text model on the CPU, measured inside the app's own container: 2.2 s for
the first search (loading the model), 20 ms for each one after, and about 720 MB of memory while it is
loaded on top of the app's 210 MB. With the exact file (`fp32`) it is 1.7 GB and 50 ms. The small file
gives numbers 0.95 to 0.99 alike to the exact one's, which does not change what is found. On the real
library, words that fit a picture score 0.11 to 0.19 and words that fit nothing score under 0.08.
`SEARCH_MEANING_FLOOR=0.085` and `SEARCH_MEANING_SPREAD=0.03` come from that.

**Near duplicates.** The library is full of bursts: 443 pictures are 0.95 alike or more to the one
taken just before, nearly all within 10 seconds. Two unrelated pictures are 0.80 alike at the
median, and a picture's nearest neighbour is 0.97. With the first rule tried (0.95, ten minutes,
neighbour to neighbour) 714 items fell into 218 groups. With the rule now in place (0.97 alike to the
first of the group, two minutes) 374 items fall into 146 groups, the largest of nine. Finding them
takes 40 ms.

**People.** About 1,050 photos: 290 faces in 209 pictures, 0.4 s a picture including fetching
the original. Likenesses between faces fall into two clear heaps, around 0 for different people and
0.3 to 0.8 for the same person. `FACE_CLUSTER=0.45` comes from that.

**Places.** 1,315,228 place names kept of 13,483,792 lines, loaded in 50 seconds, 269 MB in Postgres.
Nearly every located item got a finer name. A lookup is about 1 ms.

**The worker on Windows.** `install.ps1` was run on Windows 11 itself, not in WSL: the tests pass,
`check` finds the site and the model server, and both ONNX models run on the GPU with the NVIDIA
libraries from pip (embedding 60 ms and faces 86 ms a picture while the bench was using the same GPU).
The environment is 1.9 GB.

## Moving a library, and public stories

Two things added in November 2026. Both were built in the hosted product's repository first and carried here,
without the parts that only a host of many libraries needs.

### Export and import of a whole library

**What was built.** `src/server/portable.ts` writes a library to one gzip file and reads one back.
The first line is a manifest (format, version, app version, the newest migration, counts per table,
where the files were). Every other line is one row, `{ t, r }`, in an order that satisfies foreign keys.
It is written through a cursor inside one read-only snapshot, 500 rows at a time, and read line by line,
so the size of the library does not matter. Times are text with microseconds (`taken_at` without a zone),
bytes are base64. It is not a database dump on purpose: a dump can carry SQL and must never be restored
on the shared host.

The tables and columns an export may hold come from the Drizzle schema, in the list at the top of that
file. A new table travels only when it is added there. Left out always: sessions, tokens, jobs, workers,
place_names, and every setting except `faces:auto`, `public:site` and `cloudai` (which travels without its
key and switched off). A task a worker was holding is written as waiting, and a reel that was being made
as failed, because the worker and the job stay behind.

An import checks the whole file first without touching the database (format, version, a schema no newer
than this server's, known tables, known columns, the kind of every value, the counts), then loads it in one
transaction on one connection: delete the library's tables children first, insert in batches with bound
parameters, fix up who owns it, commit. Table and column names in the SQL are this server's own, never the
file's. A library that has items needs `replace` and the typed word, and `runBackup` runs first. Workers of
this server are kept. The `cloudai` setting is the hosted product's and is carried so that a library can go
there and back. Nothing here reads it.

Who owns it afterwards: the person importing stays an owner with the password they have here (matched to
an imported person by email, or put back if the export does not know them). An owner
who comes from the hosted service has no password in the file, because that one is kept by the main site:
`library:import` prints a one-time reset link for them.

Routes are in `routes/portable.ts`, the page is the "Move this library" card in `admin.js`. Exports live
under `exports/` in the library's storage, the newest three, listed in `export:list` with progress in
`export:state`. `Storage` has a new `exists(key)`. The command line has `library:export`, `library:import`
(`import` was already taken by the folder importer), `media:push` and `media:pull`.

**Verified** by `test/export.test.ts` against real Postgres: a round trip between two servers with a HEIC,
an edited copy, tags (one of them SQL), likes, comments, a story with sections, covers, a share link with
a password, a published story, a person with a named face, an embedding and a corrected caption, compared
through the API and row by row; `taken_at` to the microsecond; what stays behind; owner only on every route;
thirteen kinds of refusal each leaving the library unchanged; a failure half way rolled back; the typed word
and the backup; the command line; `media:push` and `media:pull` against `s3rver`.

In a browser (Playwright, November 2026): an export made from the "Move this library" window, the file looked
into, an import refused without the typed word, and an import through the window that put a changed library
back exactly as it was.

**Not verified.** A real Space or AWS (only `s3rver`). A large library: the code
streams, but the largest export made was a few items, so no timing and no memory figure. A multi-gigabyte
upload of an export through a reverse proxy. An export made while uploads are still processing arrives with
those items stuck at "processing", because their jobs are not carried: the README says to wait.

### Public stories

**What was built.** Four columns on `stories` (`public`, `featured`, `public_download`, `slug`) in
migration `0014_public_stories`. A `publish` capability beside the others: owners always, an editor only
when `caps.publish` is true, nobody else whatever the database says (`effectiveCaps`), and the server
refuses to set it for a commenter or viewer. `PATCH /api/stories/:id/public` does the publishing. Featured
is one per library, set and cleared by one statement.

What a visitor gets is not a second serialiser. `routes/share.ts` now exports `visitorStory`,
`sendStoryFile` and `sendStoryMusic`, and both the share link routes and `routes/public.ts` call them.
A test compares the two answers for the same story and they are equal. The public routes are
`/api/public`, `/api/public/stories/:slug` and its `files` and `music`, all rate limited. A slug that is
unknown, a story that was never published and one that was unpublished give the same 404 with the same words.

The pages `/p` and `/p/<slug>` are the ordinary front end, served by `app.ts` with a different `<head>`:
the built page carries `noindex, nofollow`, and that line is taken out, and Open Graph tags put in
(escaped), only when the owner turned "Let search engines list it" on. `robots.txt` follows the same switch.
The preview picture is `/p/<slug>/cover` so that it sits under the one path `robots.txt` allows. In the
browser, `public.js` reuses the share reader: `S.share.base` is where the story's files come from, and
`Public.frame` adds the library's title above the reader and the other stories' covers under it. At `/`
a visitor who is not signed in gets the public page when `bootstrap.public` is true, and the sign-in page
at `/?signin=1`.

The owner's own name and logo for the public page are in `public:site` (`title`, `line`, `logo`). The logo is
sent to `POST /api/admin/public/logo`, fitted inside 480 by 240 without enlarging, kept as WebP at
`public/logo-<hex>.webp` in the library's storage, and answered by `GET /api/public/logo` only while
something is published. The old file is removed when a new one is saved or the logo is taken off.

**Verified** by `test/public.test.ts`: nothing public by default, publishing, the exposed shape key by key
against a picture with a tag, description, comment, location, camera, named person and caption, file access
of every kind, trash, removal from the story, unpublishing, the capability for each role, featured, slugs,
robots header, meta, `robots.txt` and Open Graph tags off and on with a title full of quotes and angle
brackets, rate limit headers, and the name and logo (whole, never enlarged).

In a browser (Playwright, November 2026), at desktop and phone width: the public page as a visitor with the
name and logo, the Public part of the Share sheet, the "Public page" window, no cropped, rounded or squeezed
picture, and that a visitor reaches nothing private.

**Not verified.** `test/e2e.mts` was not extended and not run for
this work. How a real crawler or a link preview service treats the tags. Whether the host's own front door
should answer `robots.txt` for the main site is not part of this. The "newest" public story is the newest
made, not the most recently published: there is no column for when a story was published.

## Rules that are not negotiable

These came from the owner and the code is built around them.

- **Nothing is ever cropped, anywhere.** No `object-fit: cover`, no rounded corners on pictures, no
  fixed-shape tiles. Every box is sized from the picture's own width and height. There is a global CSS
  backstop (`img, video { object-fit: contain }`) and a browser test that measures it. Cropping exists
  only as a deliberate edit, and an edit is saved as a copy.
- **Originals are never modified.** Uploads are stored byte for byte. Edits create a new item.
- **No "Load more" buttons.** Grids draw rows as they scroll into view.
- **Private by default.** Signed-in people only, no public bucket objects. There are two exceptions, both
  added later at the owner's request and both about one story at a time: a story shared with a public
  link, and a story that is published on the library's public page. Both answer through the same two
  functions in `routes/share.ts`. There is no third way in.
- **Nothing hard-coded to one person's setup.** Names of spaces, sign-in provider, storage and map all
  come from settings or the database.
- **Plain writing.** Interface text and docs use short sentences, sentence case, and no em dashes.

## How it is put together

```
src/server/          TypeScript, Fastify 5, Drizzle ORM on node-postgres
  index.ts             start: settings, database, storage check, listen
  app.ts               plugins, security headers, routes, serves the built front end
  config.ts            every setting, with defaults (mirrors .env.example)
  db/schema.ts         all tables
  auth/core.ts         sessions, roles, capabilities, invite and reset tokens
  routes/auth.ts       setup, sign-in, OpenID Connect, invites, resets
  routes/items.ts      the index, items, tags, likes, comments, bulk, upload, copies, files, trash
  routes/stories.ts    stories
  routes/admin.ts      people, spaces, overview
  media/ingest.ts      reading files, making copies, rendering edits
  media/geo.ts         GPS to place name, offline
  storage/index.ts     local disk and S3 behind one interface
  jobs.ts              background work queue inside the app process
  cli-import.ts        folder import
src/shared/develop.js  the edit pipeline, run by both the browser preview and the server render
src/web/             the front end: plain JavaScript, no framework, no bundler
  js/*.js              joined in a fixed order by scripts/build-web.mjs into dist/web/assets/app.js
  css/app.css
  index.html
drizzle/             SQL migrations, applied at startup
test/                server tests (node:test), the browser test, fixtures
brand/               logo files
```

### The idea behind the front end

When the page opens it loads a compact row for every item the person may see (`GET /api/index`) and
keeps the list in memory. Search, filters, grouping, the timeline and the map all work on that list in
the browser, which is why they answer instantly. Afterwards the page asks only for what changed
(`GET /api/index?since=<ms>`): every 25 seconds, or every 1.5 seconds while something is being
processed. Deleted items come back in `removed`.

This is a deliberate trade. It is simple and fast up to the tens of thousands of items (see the
numbers above). Somewhere past 100,000 the first load will want splitting by year or moving filters to
the server. `src/web/js/api.js` (`Sync`) and `Lib.compute` in `library.js` are the two places that
would change.

Thumbnails and display copies never change once made, so their addresses carry no version and browsers
cache them for a year.

### Dates

`items.taken_at` is a timestamp without time zone holding the camera's wall-clock time. A photo taken
at 7:15 in Tokyo reads 7:15 everywhere. It travels to the page as `YYYY-MM-DDTHH:mm:ss` with no zone.
When a file has no date of its own, the upload falls back to the file's last-modified time in the
uploader's time zone.

### Sign-in and permissions

- A session is a random token in an httpOnly, SameSite=Lax cookie (`afterimage_session`). Only its
  SHA-256 is stored. Passwords are hashed with Argon2id.
- Every request that changes something must carry the header `x-afterimage: 1`. Browsers will not let
  another site add a custom header without permission, which is the defense against forged requests.
- Roles: owner, editor, commenter, viewer. Each maps to capabilities (`upload`, `edit`, `tag`,
  `comment`, `download`, `del`, `admin`). The owner can flip the first five per person. Deleting and
  administration stay with owners. The server checks every route. The page only hides what the server
  would refuse.
- People exist only by invitation. An invite makes a pending person and a one-time link
  (`/?invite=TOKEN`, 14 days). The link is emailed when a Resend key is set, and always shown to the
  owner to pass on. Password resets work the same way (`/?reset=TOKEN`, 2 days).
- OpenID Connect: with no users at all, the first successful sign-in becomes the owner. Afterwards a
  sign-in is accepted only if it matches a known subject, an invite link, a pending person's handle
  (`@preferred_username`), or a person's email when the provider says the email is verified.
- A view-only person can still open pictures at full size, because viewing is the point. The
  `download` capability controls the Download button and the attachment response, not what a browser
  can save from its own screen.

### Files

`GET /api/files/:id/:kind` with kind `thumb`, `display`, `full` or `orig`.

- Local storage: the app streams the file, with Range support for video.
- S3 with `S3_DELIVERY=redirect`: a 302 to a signed link that lasts `S3_URL_TTL_SECONDS`.
- `?proxy=1` forces streaming through the app. The editor uses it because a canvas may only read
  pixels that come from the page's own address.
- `?download=1` needs the `download` capability and answers with the original file name.

`full` is the original itself when a browser can show it (JPEG, PNG, WebP, GIF, AVIF) and a full-size
WebP otherwise.

### Background work

Uploads return as soon as the original is stored. A row in `jobs` asks for the rest: read the details,
make the copies, name the place. Two loops inside the app process claim jobs with
`FOR UPDATE SKIP LOCKED`, retry twice, and mark the item `failed` with the reason after the third
attempt. Jobs left `running` by a restart are put back in line at startup. Running more than one app
container against the same database is safe for this reason, though nothing else was designed around
it.

### Edits

A recipe is `{ v, adj, geo, curve, curves, lut, look }`. `v` is 2 for anything saved since group D and absent before it. The browser previews it on the 1600 px display copy. On save,
the server opens the original, applies rotation, flip, straighten and crop with sharp, then runs
`src/shared/develop.js` over the raw pixels, and stores a JPEG (quality 93, no chroma subsampling) as a
new item with `copy_of` pointing at the original. Editing a copy again loads its recipe and starts from
the first original, so quality never degrades through generations.

The pixel loop is plain JavaScript. In the sandbox it took about 0.6 seconds for 12 megapixels, and
the whole render of a 12 MP JPEG about one second. It is the obvious candidate for a native or
WebAssembly rewrite if editing very large files feels slow.

### Places

GPS coordinates are matched to the nearest sizeable town from the `all-the-cities` package (GeoNames
data, about 135,000 places), scored by population and distance within 60 km. It runs offline. It names
towns. With place names loaded from GeoNames a picture is also named after the beach, park, landmark or
neighborhood it was taken at: see "Stage 5: places beyond GPS".

## API in one screen

All under `/api`. JSON in and out. Errors are `{ "error": "sentence for a person" }`.

```
GET    /bootstrap                      what the page needs first: sign-in options, me, spaces, people
POST   /setup                          first owner (only while there are no users)
POST   /auth/login | /auth/logout
GET    /auth/link/:token               what an invite or reset link is for
POST   /auth/accept-invite | /auth/reset | /me/password
GET    /auth/oidc/start | /auth/oidc/callback

GET    /index[?since=ms]               every visible item, or only changes
GET    /items/:id                      comments, recipe, storage keys
PATCH  /items/:id                      title, desc, series, lat, lng, d
POST   /items/:id/tags                 { add, remove }
PUT    /items/:id/like   DELETE /items/:id/like
POST   /items/:id/comments   DELETE /comments/:id
POST   /items/bulk                     { ids, action: tag|untag|like|unlike|move|delete|
                                         locate|unlocate|shiftdate|setdate }, up to 5,000 ids
GET    /places/search?q=               towns and cities by name, from the built-in list
POST   /upload                         multipart: space, lastModified, tzOffset, then file
POST   /items/:id/copies               { recipe }
GET    /files/:id/:kind
GET    /trash   POST /trash/restore   POST /trash/empty     the two POSTs take an optional { ids }

GET    /stories   POST /stories   DELETE /stories/:id
PATCH  /stories/:id                    title, intro, notes, shared, groups, music, covers (1 to 4 item ids),
                                       sections ([{ title, text, ids }] or null for automatic),
                                       remove and add (item ids)
GET    /stories/:id/access             people and public links, for the Share sheet
POST   /stories/:id/links   PATCH /story-links/:id   DELETE /story-links/:id
GET    /stories/:id/reels   POST /stories/:id/reels { format, music, secondsPerPhoto }
GET    /reels/:id/file   DELETE /reels/:id
GET    /music   POST /music   GET /music/:ref/file   DELETE /music/:id

No sign-in, for a visitor with a public link:
GET    /share/:token                   the story, or { locked: true }
POST   /share/:token/unlock            { password }
GET    /share/:token/files/:id/:kind   GET /share/:token/music   POST /share/:token/upload

No sign-in, for anyone, published stories only (outside /api: GET /p, /p/:slug, /p/:slug/cover, /robots.txt):
GET    /public                         the front page: the featured or newest story open, the others as covers
GET    /public/stories/:slug           one published story
GET    /public/stories/:slug/files/:id/:kind   GET /public/stories/:slug/music
PATCH  /stories/:id/public             { public, featured, allowDownload, slug }   needs the publish capability
GET    /admin/public   PUT /admin/public { title, line, index }

GET    /admin/exports   POST /admin/export { wait }   GET /admin/exports/:name
POST   /admin/import[?replace=1&confirm=replace]       multipart: file
POST   /admin/import/from-storage      { name, replace, confirm }

GET    /people   POST /people/invite   POST /people/:id/link   PATCH /people/:id   DELETE /people/:id
POST   /spaces   PATCH /spaces/:id   DELETE /spaces/:id   POST /spaces/order { ids }
GET    /admin/overview
PATCH  /items/:id/ai { caption, scene, add, remove }     correct what a worker read
GET    /search?q=&space=   GET /items/:id/similar   GET /duplicates?space=
GET    /faces/overview?space=   GET /faces/review?space=   GET /faces/numbers?space=
GET    /faces/:id/crop   GET /items/:id/faces
POST   /faces/name { faceIds, name | personId }   POST /faces/reject   POST /faces/ignore { faceIds, as }
PATCH  /persons/:id   POST /persons/:id/merge { into }   DELETE /persons/:id
POST   /faces/settings { space, on } | { auto: { on, threshold } } | { wipe: true }
GET    /place-suggestions?space=   POST /place-suggestions/accept   POST /place-suggestions/reject
GET    /admin/places   POST /admin/places/fetch   POST /admin/places/rename
GET    /admin/workers   POST /admin/workers { name }   PATCH /admin/workers/:id { name, paused }
DELETE /admin/workers/:id   POST /admin/workers/redo { task }

A worker's token, not a signed-in person:
POST   /worker/claim { want, tasks }   POST /worker/results { results }   POST /worker/heartbeat
POST   /worker/release { itemIds }
GET    /worker/files/:id/:kind         display or orig, of an item the worker has claimed
GET    /health
```

## Known gaps and honest limits

- **Uploads are not resumable.** A dropped connection means sending the file again. Fine on a desk,
  weak on a phone. Resumable uploads belong with the iPhone app, which is postponed.
- **Email is optional.** Without a Resend key, invites and resets are links the owner copies.
- **Public sharing is by story link only.** See "Stories, sharing, music and reels" above.
- **Storage paths use the upload-time date,** which is the file's last-modified date, not always the
  EXIF date. The database holds the true date. The folders are for humans browsing the bucket.
- **Video** gets a poster frame and plays the original file. There is no transcoding, so a format the
  browser cannot play (some MKV and AVI, HEVC in some browsers) will download instead of playing.
- **RAW camera files** (CR3, NEF, ARW, DNG) are not accepted yet.
- **Reading the pictures needs a worker.** With none connected the Scenes, In the picture, People and
  By meaning parts stay empty, and everything else works.
- **Favorites of looks, recent locations and the like are per browser.** So is nothing in Phase 3:
  names, corrections and answers are all on the server.
- **The first person to finish setup becomes the owner.** Complete setup before exposing the address.

## Changing the database

Edit `src/server/db/schema.ts`, run `npm run db:generate`, commit the new file in `drizzle/`. It is
applied the next time the app starts.
