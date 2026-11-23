#!/usr/bin/env node
/**
 * Przygotowuje dane dołączane do aplikacji (uruchamiane RĘCZNIE, bez zależności, Node 20+):
 *
 *   node tools/build-data.mjs            (pobiera, co trzeba, do tools/.cache/ i zapisuje MadridLive/Resources/Data/)
 *   node tools/build-data.mjs --fresh    (pobiera wszystko od nowa)
 *   node tools/build-data.mjs --only-timetable --out=KATALOG   (sam rozkład — używa tego tools/data-repo)
 *   node tools/build-data.mjs --offline  (tory: bez pytania Overpass — z tools/.cache/osm albo z kopii w ~/ELYSSE, tylko odczyt)
 *
 * 1. timetable.json — rozkład Cercanías Madryt z oficjalnego GTFS Renfe (route_id „10T…”), mocno spakowany:
 *    kursy z tym samym układem stacji i czasów dzielą jeden „wzorzec”.
 * 2. tracks.json — graf torów z OpenStreetMap (© OpenStreetMap contributors, ODbL): tylko szeroki tor (bez AVE 1435 mm),
 *    bez bocznic; współrzędne w decymetrach od środka (x = wschód, y = północ), tunel 0/1.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.ML_CACHE || join(ROOT, 'tools', '.cache');
/** --out=KATALOG: gdzie zapisać wynik (repozytorium z danymi buduje tym samym skryptem sam rozkład). */
const OUT_ARG = process.argv.find((a) => a.startsWith('--out='));
const OUT = OUT_ARG ? OUT_ARG.slice(6) : join(ROOT, 'MadridLive', 'Resources', 'Data');
const ONLY_TIMETABLE = process.argv.includes('--only-timetable');
const FRESH = process.argv.includes('--fresh');
const OFFLINE = process.argv.includes('--offline');
/** Zapas, gdy Overpass nie odpowiada: tory pobrane wcześniej w projekcie ELYSSE (węższa ramka: bez Aranjuez, Guadalajary, sierry). */
const ELYSSE_TRACKS = join(homedir(), 'ELYSSE', 'server', 'data', 'osm-cache', 'madryt-tory-szeroko.json');
const GTFS_URL = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';
const MADRID = '10T';
/** Środek układu metrów: Plaza de Cibeles. Ten sam jest w aplikacji (Geo.swift). */
const CENTER = { lat: 40.4193, lon: -3.6931 };
const OVERPASS = ['https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const UA = 'transit-map-prototype/0.1 (one-off rail export)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

async function* rows(file) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    if (line) yield line.split(',').map((s) => s.trim());
  }
}

// ---------------------------------------------------------------- 1. rozkład
async function timetable() {
  const dir = join(CACHE, 'gtfs');
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, 'gtfs.zip');
  if (FRESH || !existsSync(zip) || Date.now() - statSync(zip).mtimeMs > 20 * 3600_000) {
    console.log('pobieram GTFS Renfe…');
    const r = await fetch(GTFS_URL, { signal: AbortSignal.timeout(180_000) });
    if (!r.ok) throw new Error(`Renfe GTFS ${r.status}`);
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  }
  execFileSync('unzip', ['-o', '-q', zip, 'stops.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'routes.txt', '-d', dir]);

  // Linie: nazwa krótka + oficjalny kolor.
  const routeLine = {}, lines = {};
  for await (const [id, short, , , color, text] of rows(join(dir, 'routes.txt'))) {
    if (!id.startsWith(MADRID)) continue;
    routeLine[id] = short;
    lines[short] = { color: `#${color}`, text: `#${text || 'FFFFFF'}` };
  }
  const trips = new Map(); // id → { line, svc, st: [[stop, dep]] }
  for await (const [route, svc, id] of rows(join(dir, 'trips.txt'))) {
    if (routeLine[route]) trips.set(id, { line: routeLine[route], svc, st: [] });
  }
  console.log(`kursy Madrytu: ${trips.size}, czytam stop_times (duży plik)…`);
  const used = new Set();
  for await (const [id, arr, dep, stop, seq] of rows(join(dir, 'stop_times.txt'))) {
    const t = trips.get(id);
    if (!t) continue;
    const sec = (s) => {
      const [h, m, x] = s.split(':').map(Number);
      return h * 3600 + m * 60 + (x || 0);
    };
    t.st.push([stop, sec(dep), sec(arr), +seq]);
    used.add(stop);
  }
  const stopIdx = new Map(), stops = [];
  for await (const [id, name, lat, lon] of rows(join(dir, 'stops.txt'))) {
    if (!used.has(id)) continue;
    stopIdx.set(id, stops.length);
    stops.push([id, name.replace(/^Madrid-/, ''), +(+lat).toFixed(6), +(+lon).toFixed(6)]);
  }
  const services = {};
  for await (const c of rows(join(dir, 'calendar.txt'))) services[c[0]] = [c.slice(1, 8).join(''), c[8], c[9]];

  // Wzorce: linia + [stacja, odjazd − start, postój]… Kurs = wzorzec + godzina startu.
  const lineNames = Object.keys(lines).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const patIdx = new Map(), patterns = [], bySvc = {};
  let skipped = 0;
  for (const [id, t] of trips) {
    t.st.sort((a, b) => a[3] - b[3]);
    if (t.st.length < 2 || !id.startsWith(t.svc) || t.st.some(([s]) => !stopIdx.has(s))) {
      skipped++;
      continue;
    }
    const t0 = t.st[0][1];
    const body = [];
    for (const [s, dep, arr] of t.st) body.push(stopIdx.get(s), dep - t0, Math.max(0, dep - arr));
    const key = `${t.line}|${body.join(',')}`;
    let p = patIdx.get(key);
    if (p === undefined) {
      p = patterns.length;
      patIdx.set(key, p);
      patterns.push([lineNames.indexOf(t.line), ...body]);
    }
    const g = (bySvc[t.svc] ??= { ids: [], p: [], t: [] });
    g.ids.push(id.slice(t.svc.length));
    g.p.push(p);
    g.t.push(t0);
  }
  const usedSvc = Object.fromEntries(Object.entries(services).filter(([k]) => bySvc[k]));
  const dates = Object.values(usedSvc);
  const out = {
    generated: new Date().toISOString().slice(0, 10),
    from: dates.map((d) => d[1]).sort()[0],
    to: dates.map((d) => d[2]).sort().at(-1),
    attribution: 'Horarios: Renfe (datos abiertos, data.renfe.com)',
    lines: lineNames.map((n) => ({ name: n, ...lines[n] })),
    stops,
    patterns,
    services: usedSvc,
    trips: bySvc,
  };
  const file = join(OUT, 'timetable.json');
  writeFileSync(file, JSON.stringify(out));
  console.log(`timetable.json: ${(statSync(file).size / 1e6).toFixed(2)} MB · ${stops.length} stacji · ${patterns.length} wzorców · ${trips.size - skipped} kursów · ${out.from}–${out.to}` + (skipped ? ` · pominięte ${skipped}` : ''));
  return stops;
}

// ---------------------------------------------------------------- 2. tory
async function overpass(q, cacheFile) {
  if (!FRESH && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  if (OFFLINE) return null;
  let wait = 5000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(120_000) });
      if (r.ok) {
        const els = (await r.json()).elements;
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(els));
        return els;
      }
      console.warn(`  ${new URL(url).host}: ${r.status}, czekam ${wait / 1000} s`);
    } catch (e) {
      console.warn(`  ${new URL(url).host}: ${String(e).slice(0, 80)}, czekam ${wait / 1000} s`);
    }
    await sleep(wait);
    wait = Math.min(60_000, wait * 2);
  }
  return null;
}

async function tracks(stops) {
  // Ramka = wszystkie stacje núcleo Madryt + zapas (Aranjuez, Guadalajara, El Escorial, Cercedilla…).
  const la = stops.map((s) => s[2]), lo = stops.map((s) => s[3]);
  const [S, W, N, E] = [Math.min(...la) - 0.02, Math.min(...lo) - 0.03, Math.max(...la) + 0.02, Math.max(...lo) + 0.03].map((v) => +v.toFixed(3));
  console.log(`tory z OSM, ramka ${S},${W},${N},${E}…`);
  let els = await overpass(`[out:json][timeout:240];way["railway"="rail"](${S},${W},${N},${E});out tags geom;`, join(CACHE, 'osm', 'tory.json'));
  if (!els) {
    if (!existsSync(ELYSSE_TRACKS)) throw new Error('Overpass niedostępny i brak kopii torów — spróbuj później.');
    console.warn('  Overpass niedostępny → tory z kopii ELYSSE (węższa ramka). Uruchom skrypt ponownie później, żeby mieć całą sieć.');
    els = JSON.parse(readFileSync(ELYSSE_TRACKS, 'utf8'));
  }
  const mx = 111_320 * Math.cos((CENTER.lat * Math.PI) / 180), my = 110_574;
  const out = [];
  let pts = 0, dropped = 0;
  for (const el of els) {
    const t = el.tags ?? {};
    // Bez bocznic i torów postojowych; bez samych torów AVE (1435 mm) — Cercanías jeżdżą po torze iberyjskim (C9: 1000 mm).
    if (['yard', 'siding', 'spur'].includes(t.service) || t.gauge === '1435' || t.highspeed === 'yes') {
      dropped++;
      continue;
    }
    const g = el.geometry ?? [];
    if (g.length < 2) continue;
    // Tunel = naprawdę pod ziemią (tunnel=yes); tory pod dachem dworca (building_passage) zostają „na powierzchni”.
    const w = [t.tunnel === 'yes' ? 1 : 0];
    for (const p of g) w.push(Math.round((p.lon - CENTER.lon) * mx * 10), Math.round((p.lat - CENTER.lat) * my * 10));
    pts += g.length;
    out.push(w);
  }
  const file = join(OUT, 'tracks.json');
  writeFileSync(file, JSON.stringify({ attribution: '© OpenStreetMap contributors (ODbL)', center: [CENTER.lat, CENTER.lon], unit: 0.1, t: out }));
  console.log(`tracks.json: ${(statSync(file).size / 1e6).toFixed(2)} MB · ${out.length} odcinków · ${pts} punktów · odrzucone ${dropped}`);
}

const stops = await timetable();
if (!ONLY_TIMETABLE) await tracks(stops);
