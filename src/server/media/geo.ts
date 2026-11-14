import { createRequire } from 'node:module';

interface City {
  name: string;
  country: string;
  population: number;
  loc: { coordinates: [number, number] };
}
export interface PlaceHit {
  name: string;
  region: string;
  country: string;
  lat: number;
  lng: number;
}

let grid: Map<string, City[]> | null = null;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** 135,000 towns and cities (GeoNames, via the all-the-cities package), bucketed by whole degree. Loaded on first use. */
function load() {
  if (grid) return grid;
  const require = createRequire(import.meta.url);
  const cities = require('all-the-cities') as City[];
  grid = new Map();
  for (const c of cities) {
    const [lng, lat] = c.loc.coordinates;
    const k = `${Math.floor(lat)}:${Math.floor(lng)}`;
    let cell = grid.get(k);
    if (!cell) grid.set(k, (cell = []));
    cell.push(c);
  }
  return grid;
}

const km = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(x, lat2 - lat1) * 111.2;
};

export interface PlaceMatch extends PlaceHit { population: number }
let names: { key: string; alt: string; c: City }[] | null = null;
const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const countryName = (code: string) => { try { return regionNames.of(code) ?? code; } catch { return code; } };

/**
 * Find towns and cities by name, with no outside service. Names that start with what was typed come
 * first, then names that contain it, and within each the larger place wins.
 */
export function searchPlaces(query: string, limit = 12): PlaceMatch[] {
  const q = plain(query);
  if (q.length < 2) return [];
  if (!names) {
    const require = createRequire(import.meta.url);
    names = (require('all-the-cities') as (City & { altName?: string })[]).map((c) => ({ key: plain(c.name), alt: plain(c.altName ?? ''), c }));
  }
  const hits: { rank: number; c: City }[] = [];
  for (const n of names) {
    const rank = n.key === q ? 0 : n.key.startsWith(q) ? 1 : n.alt && n.alt.startsWith(q) ? 2 : q.length >= 3 && n.key.includes(q) ? 3 : -1;
    if (rank >= 0) hits.push({ rank, c: n.c });
  }
  hits.sort((a, b) => a.rank - b.rank || b.c.population - a.c.population);
  return hits.slice(0, limit).map(({ c }) => ({ name: c.name, region: countryName(c.country), country: c.country, lat: c.loc.coordinates[1], lng: c.loc.coordinates[0], population: c.population }));
}

/**
 * Name the place a photo was taken, with no outside service.
 * Picks the town that best explains the spot: close counts most, but a real city a little
 * further away beats a hamlet next door, so a beach outside a city is filed under that city.
 */
export function nearestPlace(lat: number, lng: number): PlaceHit | null {
  const g = load();
  let best: City | null = null;
  let bestScore = -Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell = g.get(`${Math.floor(lat) + dy}:${Math.floor(lng) + dx}`);
      if (!cell) continue;
      for (const c of cell) {
        const d = km(lat, lng, c.loc.coordinates[1], c.loc.coordinates[0]);
        if (d > 60) continue;
        const score = Math.log10(c.population + 10) - d / 12;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
  }
  if (!best) return null;
  let country = best.country;
  try {
    country = regionNames.of(best.country) ?? best.country;
  } catch {
    /* keep the code */
  }
  return { name: best.name, region: country, country: best.country, lat: best.loc.coordinates[1], lng: best.loc.coordinates[0] };
}
