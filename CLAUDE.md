# ImageStoria

The product is called ImageStoria (imagestoria.com). It was called AfterImage until November 2026, and
the old word is still in names a person never reads: the `x-afterimage` header, the `afterimage.`
keys in browser storage, the `afterimage_worker` Python package, the database and container names,
and the repository. Leave those as they are. Anything a person reads says ImageStoria.

Self-hosted photo and video archive, viewer, editor and storyteller. One Docker image plus Postgres.
Read `docs/HANDOFF.md` before changing anything: it says what was tested, what was not, and why things
are built the way they are. Phase 3 (reading the pictures on machines of the owner's own) is built:
see "Phase 3" in the hand-off notes.

## Commands

```sh
npm install
npm run dev          # server with reload on :8080 (needs DATABASE_URL and ffmpeg)
npm run build        # front end into dist/web, server into dist/server
npm run typecheck
npm test             # needs Postgres: TEST_PG=postgres://user@host:port (default postgres://postgres@127.0.0.1:54329)
npm run test:e2e     # needs Playwright (npm i -D playwright), optionally CHROME=/path/to/chrome
npm run db:generate  # after editing src/server/db/schema.ts
(cd worker && .venv/bin/python -m unittest discover -s tests)   # the worker's own tests, after sh install.sh
```

After changing anything in `src/web` or `src/shared`, run `npm run build:web`. The server serves
`dist/web`, never `src/web`.

## Layout

- `src/server`: Fastify 5, Drizzle on node-postgres, TypeScript with NodeNext modules (imports end in `.js`).
- `src/web`: plain JavaScript, no framework, no bundler. Files are joined in the order listed in
  `scripts/build-web.mjs` and share one global scope. A new file must be added to that list.
- `src/shared/develop.js`: the edit pipeline. The browser and the server both run it. Change it once
  and both stay in step.
- `src/server/ai`: what workers do and what the server makes of it (tasks, results, embeddings, faces).
  `src/server/routes/worker.ts` is the only door a worker has.
- `worker/`: the Python program that runs on the owner's GPU machine. It has its own README and tests.

## Rules

- Nothing is ever cropped, anywhere. No `object-fit: cover`, no fixed-shape tiles, no rounded corners
  on pictures. Size every box from the picture's width and height.
  Two things are not library pictures and are the only exceptions: a person's profile picture in its round
  badge, and a face cut from a picture on the People page (square corners, the face's own shape).
- Originals are never modified. An edit is a new item.
- No "Load more" buttons. Draw what is on screen as it scrolls.
- A blurred backdrop behind a picture (the slideshow, reels) may be cut to fill the frame. The picture
  itself, on top of it, is always whole.
- Private by default: signed-in people only, no public bucket objects. There are two exceptions, both
  about one story at a time, and no others:
  1. A story that its owner or an editor shares with a public link (`src/server/routes/share.ts`). A link
     reaches that one story and nothing else, and deleting the link ends it.
  2. A story that is published (`stories.public`, `src/server/routes/public.ts`). Anyone can read it at the
     library's own address, `/p` and `/p/<slug>`, and at `/` when nobody is signed in. Only an owner, or an
     editor the owner gave the `publish` switch, can publish. Unpublishing ends it at once.
  Both answer through the same two functions in `share.ts` (`visitorStory`, `sendStoryFile`), which decide
  everything that leaves the library this way: the story's own pictures as thumb and display copies, a
  video's playable file, originals only when downloads are allowed, and no tags, descriptions, comments,
  camera details, exact coordinates, names of people or faces. Change what a visitor sees there and
  nowhere else. Do not add any other way in, and do not add a route that reads anything but a shared or
  published story without a session.
- Nothing specific to one install in the code. Use settings (`src/server/config.ts`, `.env.example`) or the database.
- The server enforces every permission. Hiding a button is not a permission.
- Every route that changes something needs the `x-afterimage: 1` header (handled by `api()` in `src/web/js/core.js`).
- Interface text and docs: short plain sentences, sentence case, no em dashes, no filler.
- Error messages are sentences a person can act on. They go to the page as `{ "error": "..." }`.
- No picture and no face ever goes to an outside service. Models run on the owner's machines. The site
  never connects to a worker: the worker asks.
- Blue is what a machine said, amber is what a person said, everywhere. A person's edit always wins over a
  machine's result, now and after any re-run. Every result records the model and version that made it.
- Face embeddings are biometric data. No route returns one, nothing logs one, and they are deleted with
  the item, the person, or the space's recognition switch. Names of people are for the owner and editors.
- A suggestion (a person's name, a place) is never stored as fact until a person accepts it.
- A library moves between servers as an export the app writes and reads itself (`src/server/portable.ts`),
  never as a database dump: a dump can carry any SQL. An export is untrusted when it is read. A new table or
  column travels only when it is in the list in that file, and what must stay behind (sessions, tokens, jobs,
  workers, and the hosted service's own settings) stays out of it.
- Add a test with every change in behavior. Server tests live in `test/*.test.ts`, browser checks in `test/e2e.mts`.
