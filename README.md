<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/imagestoria-logo-for-dark-backgrounds.png">
  <img src="brand/imagestoria-logo-for-light-backgrounds.png" alt="ImageStoria by Chaz.Art" width="420">
</picture>

# ImageStoria by Chaz.Art

A private home for photos and videos that you run yourself. It keeps every original untouched, shows
every picture whole (nothing is ever cropped, anywhere), and lets the people you choose browse, comment,
edit copies and tell stories with them.

This repository is the standalone app: one Docker image plus Postgres. Sign-in is local accounts,
SolPersona (or any OpenID Connect provider), or both. Files live on local disk or in any S3-compatible
bucket such as DigitalOcean Spaces.

## What is in it

- **Library.** A justified grid that keeps each photo's own shape. Rows are drawn only while they are on
  screen, so a library of tens of thousands scrolls without a "Load more" button. Instant search, filters
  for places, tags, colors, cameras and years, a timeline on the right edge, and multi-select with bulk
  tag, location, date, like, move, download, story and trash.
- **Housekeeping.** Set a location for a whole selection from a map, a search over town names, the
  places already in the library or typed coordinates. Shift the dates of a selection when a camera's
  clock was wrong, with an undo, or give scans one date. Quick filters find what has no location and
  what has no date from the camera.
- **Two kinds of space.** A space is a separate library with its own people. "Life" style spaces arrange
  by date, "Studio" style spaces by series. A new install starts with one of each. Owners add one with the
  "+" beside the space tabs, and rename, order or remove them on the settings page.
- **Viewer.** Title, description, tags, comments and likes, a round magnifier on hover, and the original
  at full size with pan and zoom on click, inside the same window. Videos play when opened.
- **Map.** Pins with a small bundle of uncropped thumbnails beside them, on OpenFreeMap. No key, no
  account, no bill.
- **Editor.** Light, color, tone curve, color grade, effects, looks, crop, straighten, turn and flip.
  A round magnifier shows the edited result at the detail of the full-size file.
  Saving sends only the settings. The server develops the full-size original with them and stores the
  result as a new item. The original is never changed.
- **Stories.** Photos told in order with your words between them, read as a page or played full screen.
  Start one from scratch and pick what goes in one by one, by place, by day or by moment (pictures taken
  close together in one place). A picture can be in several stories. The author chooses a cover of up to
  four pictures, breaks the story into sections with their own titles and text, drags pictures into the
  order wanted, and takes pictures or whole sections out again. Stories can be filed under groups such
  as Sunsets or Road trips. Videos play through in the player.
- **Sharing a story.** Owners and editors choose which other people can read a story. They can also
  make public links: anyone with the link opens that story without signing in, and sees nothing else.
  A story can have several links, each with its own options: view only, download the originals, a
  password, and letting visitors add their own photos. Deleting a link ends it at once.
- **Music.** Ten pieces come with the app, from still to driving. The server composes and plays them
  itself, so nothing is downloaded and no outside service is used. You can add tracks of your own.
  A story's music plays under its slideshow and dips while a video with sound is playing.
- **Reels.** A story as one video file, tall (9:16) or wide (16:9), made by the server with ffmpeg.
  Every picture and video is shown whole over a blurred copy of itself, with the story's music under it.
- **People.** Invite-only. Four roles (owner, editor, commenter, viewer), per-person switches for
  upload, edit, tag, comment and download, and per-person access to spaces. Invites and password reset
  links are emailed when a Resend key is set, and are always shown to copy.
- **Trash.** Deleted items wait in a trash the owner can look through, put back from, and delete from
  for good. `TRASH_DAYS` can remove them by itself after a number of days.
- **Uploads.** Drop files or folders on the page. JPEG, PNG, WebP, GIF, AVIF, TIFF, BMP, iPhone HEIC,
  and MP4, MOV, M4V, WebM, MKV and AVI video. Date, GPS and camera are read from the file, GPS is turned
  into a place name without calling any outside service, and a file that is already in the library is
  skipped.

- **Reading the pictures, on your own machines.** A worker on a GPU machine of yours writes a caption,
  the scene and what is in each picture, makes search by meaning work, finds near duplicates, finds the
  faces for you to name, and suggests a place for pictures that have none. No picture goes to an outside
  service. See "Workers" below.

Not built: the iPhone backup app, which is postponed.

## Run it

You need Docker with the Compose plugin.

```sh
git clone https://github.com/chazartco/imagestoria.git
cd imagestoria
cp .env.example .env        # then open .env and set PUBLIC_URL and POSTGRES_PASSWORD
docker compose up -d --build
```

Open the address you set as `PUBLIC_URL` (by default <http://localhost:8080>). The first visit shows a
setup screen. Whoever completes it becomes the owner, so do this right away, before the address is
reachable by anyone else.

To update later: `git pull && docker compose up -d --build`. Database changes are applied when the app
starts.

### Behind a reverse proxy

For anything beyond your own machine, put it behind HTTPS and set `PUBLIC_URL` to the https address.
The proxy needs to:

- pass requests to port 8080 and send the usual `X-Forwarded-For` and `X-Forwarded-Proto` headers,
- allow large request bodies, up to `MAX_UPLOAD_MB` (8 GB by default). nginx stops at 1 MB unless
  `client_max_body_size` is raised. Caddy has no limit by default,
- not time out long uploads.

`GET /api/health` answers `{"ok":true}` for health checks.

## Settings

Every setting lives in `.env` and is described there. [.env.example](.env.example) is the reference.
The ones most people touch:

| Setting | What it does |
| --- | --- |
| `PUBLIC_URL` | The address people type. Invite links and sign-in redirects are built from it. |
| `LOCAL_AUTH` | Email and password accounts. On by default. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Turn on SolPersona or another OpenID Connect provider. |
| `STORAGE_DRIVER` | `local` or `s3`. |
| `S3_*` | Bucket address and keys when `STORAGE_DRIVER=s3`. |
| `MAX_UPLOAD_MB` | Largest single upload. |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO` | Send invites and reset links by email. Off without a key. |
| `TRASH_DAYS` | Days a deleted item stays in the trash. `0`, the default, means until you delete it. |
| `REEL_MAX_ITEMS`, `REEL_VIDEO_MAX_SECONDS` | How much one reel may hold, and how long any one video plays in it. |

### Email

Without a key the server sends nothing, and the owner copies invite and reset links by hand. To send them:

1. Make an account at [resend.com](https://resend.com), add your domain under Domains, and add the DNS
   records it shows. Resend refuses mail from a domain that is not verified.
2. Create an API key and set `RESEND_API_KEY`. Set `MAIL_FROM` to an address on that domain, for
   example `ImageStoria <photos@example.com>`. Restart the app.
3. Send yourself a test: `docker compose exec app npm run mail:test -- you@example.com`. It says what
   went wrong if anything did.

An invite is made, and its link shown, whether or not the email could be sent. An invite by SolPersona
handle has no address, so its link is still yours to pass on.

### Sign-in with SolPersona

1. In SolPersona, open Admin, then Clients, and add a client. Type: confidential. Redirect address:
   `<PUBLIC_URL>/api/auth/oidc/callback`. Scopes: `openid profile email`.
2. Put the client id and secret in `.env` as `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, and set
   `OIDC_ISSUER` to SolPersona's address (the app reads
   `<OIDC_ISSUER>/.well-known/openid-configuration` from it).
3. Restart: `docker compose up -d`.

The sign-in page then offers "Continue with SolPersona". Signing in does not create access by itself:
the owner still adds each person on the settings page, by email or by SolPersona handle (`@name`).
An owner who started with a password can attach SolPersona from the account menu. Set
`LOCAL_AUTH=false` to make SolPersona the only way in. Any other OpenID Connect provider works the same
way. Change `OIDC_NAME` to rename the button.

### Files in DigitalOcean Spaces (or any S3-compatible bucket)

```ini
STORAGE_DRIVER=s3
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_REGION=us-east-1
S3_BUCKET=your-space-name
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=afterimage
```

Keep the bucket private. The app never makes a file public. With `S3_DELIVERY=redirect` (the default)
the browser fetches each picture straight from the bucket through a signed link that expires, so the
app does not carry the traffic. No CORS rules are needed on the bucket. Use `S3_DELIVERY=proxy` if the
bucket cannot be reached from people's browsers.

Inside the bucket (or the `media` volume when storage is local):

```
originals/{year}/{month}/{item id}/{file name}   the file exactly as it was uploaded
display/{year}/{month}/{item id}.webp            long edge 1600 px
thumbs/{year}/{month}/{item id}.webp             360 px high
full/{year}/{month}/{item id}.webp               full size, only for formats browsers cannot show (HEIC, TIFF)
```

The year and month come from the file's own date at the moment it was uploaded.

Moving an existing library from local disk to a bucket is a copy of the `media` folder into the bucket
(under `S3_PREFIX` if set) with the same paths, then a change of `STORAGE_DRIVER`.

## Workers: reading the pictures on your own machines

A worker is a program on a machine of your own, usually one with a GPU, that reads the pictures: a
caption, the kind of scene, what is in it. It asks this site for work, fetches the pictures it is given
and sends back what it found. No picture goes to an outside service, and the site never connects to
your machines, so a worker runs behind a home router with nothing opened.

1. Open **People and settings**, open the **Workers** card, name the machine and press **Make a token**.
   The token is shown once. Only its hash is stored.
2. Put the token and the site's address in the worker's config file. The worker lives in `worker/` and
   has its own README.
3. The machine shows up in the Workers section with when it last checked in and what is waiting.
   **Pause** stops it taking work. **Revoke** ends the token. **Read everything again** puts the whole
   library back in line for one task, for when you change to a better model.

A token can claim work, fetch the files of items it has claimed, post results and say it is alive. It
opens nothing else. With files in a bucket the worker receives signed links and downloads straight
from the bucket. The site works the same with no worker connected.

`AI_LEASE_MINUTES` (default 10) is how long a worker may hold an item before it goes back in line.
`AI_MAX_ATTEMPTS` (default 3) is how often one task is tried before it is marked failed.
`AI_TASKS` lists the kinds of work the site hands out. Leave one out to turn it off.

What a worker read is shown in blue. What a person said is shown in amber. Anyone who may tag can
correct a caption or a scene and remove or add a label, and reading the library again never undoes that.

### Search by meaning

Typing in the search box filters the library at once by the words themselves. With a worker running
the `embed` task, pictures that fit the words by what they show are listed underneath, under "By
meaning". The viewer's "More like this" goes by looks, and a "Near duplicates" filter groups bursts
and re-exports so you can keep the best and trash the rest. Nothing is ever removed by itself.

The words are turned into numbers by a small text model on this server's CPU. The first search after
a start fetches it from Hugging Face into `DATA_DIR/models` (about 320 MB, once) and takes a few
seconds. While loaded it uses about 800 MB of memory, and it is let go after 15 quiet minutes. On a
server with less memory to spare set `EMBED_TEXT=false`: everything else still works. To run with no
outside connection, put `config.json`, `tokenizer.json`, `tokenizer_config.json` and
`onnx/text_model_quantized.onnx` from the model's page into
`DATA_DIR/models/onnx-community/siglip2-base-patch16-224-ONNX/` yourself.

### People

People recognition is off until the owner turns it on, one space at a time, under "People in the
pictures" in People and settings. A worker running the `faces` task then finds the faces. There you
name a group of look-alike faces once, choose any number of single faces and name them together,
answer suggestions with Y and N, and may turn on automatic naming after reading how well it would have
done on the faces you confirmed. Every automatic name is marked, listed and undone with one click. The People tab shows who has been named, and a person's
pictures when you choose them.

Only the owner and editors see names, face outlines and the People page. People belong to one space.
Face data is biometric data: it stays in this database, is never sent to a browser, and is deleted
with the item, with the person, when a space is turned off, or all at once.

### Places

Every picture with a location is filed under its nearest town. To also name the beach, park,
landmark or neighborhood, load place names once, from the settings page or with:

```sh
docker compose exec app npm run places                 # fetches about 400 MB from geonames.org
docker compose exec app npm run places -- /data/allCountries.zip   # or reads a file you already have
docker compose exec app npm run places -- rename       # names the library again from the data loaded
```

About 1.3 million names are kept, about 270 MB in the database. Place names come from GeoNames
(geonames.org) under the Creative Commons Attribution 4.0 licence.

A picture with no location may get a suggestion: from a picture the same camera took within ten
minutes, or from a place a worker's vision model recognised. A suggestion is a guess and is shown as
one. It becomes the location only when someone accepts it, and a rejected one is not made again.

## Bring in an existing folder of photos

Mount the folder read-only (see the commented line in `docker-compose.yml`), then:

```sh
docker compose exec app node dist/server/cli-import.js /import --space life --dry-run
docker compose exec app node dist/server/cli-import.js /import --space life
```

It walks every subfolder, copies photos and videos into storage, and skips anything already in the
library. The folder itself is never changed. `--space` takes the name of a space. The running app
makes the display copies and thumbnails in the background.

## Back it up

Two things hold everything, and each needs its own backup:

- **the files**: the pictures and videos, in the `media` volume or in the bucket. Nothing in this app makes a
  second copy of them. Copy the volume somewhere else, or turn on versioning or replication for the bucket.
- **the database**: titles, tags, comments, stories, people and edits. The app can back this up by itself.

### The database

Set a time of day in `.env` and a backup is made every night:

```sh
BACKUP_SCHEDULE=03:30                  # on the server's clock. Empty or "off" turns it off
BACKUP_KEEP=14                         # how many to keep
BACKUP_PASSPHRASE=a long passphrase    # recommended: the dump holds password hashes
```

Each backup is one compressed `pg_dump`, stored with the files under `backups/`: in the bucket when the files are
in a bucket, and in the `media` volume otherwise. **In the volume it sits on the same disk as the database, which
is no protection against losing that disk.** Copy `backups/` somewhere else if you run that way.

The settings page shows the last backup, the last failure with its reason, and a "Back up now" button.
From the command line: `docker compose exec app npm run backup`.

**This covers the database only.** A restored database with no files shows a library of empty frames.

### Restore the database

1. Get the backup file. From the volume: `docker compose cp app:/data/media/backups/afterimage-20260101-033000.dump .`
   From a bucket, download it from `backups/`.
2. If its name ends in `.enc`, open it with the passphrase. Either with the app:

   ```sh
   docker compose exec app npm run backup -- open /data/media/backups/afterimage-20260101-033000.dump.enc /data/tmp/afterimage.dump
   ```

   or with openssl alone, anywhere:

   ```sh
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in afterimage-20260101-033000.dump.enc -out afterimage.dump
   ```

3. Stop the app so nothing writes while you restore: `docker compose stop app`
4. Restore into the database. This replaces what is there:

   ```sh
   docker compose exec -T db pg_restore --clean --if-exists --no-owner -U afterimage -d afterimage < afterimage.dump
   ```

   Into a new, empty database leave out `--clean --if-exists`.
5. Start the app: `docker compose start app`

`pg_restore` must be the same version as the `pg_dump` that made the file, or newer. The app image carries
version 17. The `db` service in `docker-compose.yml` is 16, and a 16 `pg_restore` cannot read a 17 dump, so if step 4
says the file's version is not supported, run the restore from the app container instead:

```sh
docker compose run --rm -T app sh -c 'pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL"' < afterimage.dump
```

## Work on it

The worker in `worker/` is a separate Python program with its own README and tests.

```sh
npm install
npm run dev          # the server with reload, on :8080. Needs Postgres (DATABASE_URL) and ffmpeg
npm run build:web    # rebuild the front end into dist/web after changing src/web
npm test             # server tests. Needs a Postgres it may create databases in (TEST_PG)
npm run test:e2e     # browser tests. Needs Playwright: npm i -D playwright
```

The layout, the API and the decisions behind them are in [docs/HANDOFF.md](docs/HANDOFF.md).

## License

ImageStoria is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

- You may run it, change it and share it for personal use and for any other noncommercial purpose:
  your own photos, your family's, a club, a school, a charity, research.
- You may not use it commercially. That includes selling it or offering it to others as a paid or
  hosted service.
- For a commercial license, write to Chaz.Art & Co through [imagestoria.com](https://imagestoria.com).

Copyright (c) 2026 Chaz.Art & Co.

## Credits

Maps by [OpenFreeMap](https://openfreemap.org), drawn with [MapLibre GL JS](https://maplibre.org), with
data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Place names from
[GeoNames](https://www.geonames.org). Typefaces: Bricolage Grotesque and Newsreader. Details in
[NOTICE.md](NOTICE.md).
