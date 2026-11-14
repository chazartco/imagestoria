# Credits and licenses of what ImageStoria is built with

Required Notice: Copyright (c) 2026 Chaz.Art & Co (https://imagestoria.com)

ImageStoria's own code and logo belong to Chaz.Art & Co, and are offered under the PolyForm
Noncommercial License 1.0.0 in [LICENSE.md](LICENSE.md). The pieces below belong to their authors and
are used under their licenses. The full license texts ship inside each package in `node_modules`.

## Shown to people using the app

- **Map tiles and styles:** [OpenFreeMap](https://openfreemap.org), built on
  [OpenMapTiles](https://openmaptiles.org), with map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors. The attribution appears in the corner of every map and must stay there.
- **Map drawing:** [MapLibre GL JS](https://maplibre.org) (BSD 3-Clause).
- **Place names:** the `all-the-cities` package, built from [GeoNames](https://www.geonames.org) data
  (Creative Commons Attribution).
- **Typefaces:** Bricolage Grotesque and Newsreader, both under the SIL Open Font License, packaged by
  [Fontsource](https://fontsource.org) and served from this app.

## On the server

Fastify and its plugins, Drizzle ORM, node-postgres, sharp (libvips), exifr, heic-convert (libheif),
@node-rs/argon2, zod, the AWS SDK for JavaScript (S3 client), and FFmpeg, which is installed in the
Docker image as a separate program and run for video.

To list every package and its license: `npx license-checker --summary`.
