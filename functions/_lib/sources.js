// Live data loaders. Everything is aligned to an SGT hour axis (see features.js).
import { HIST, FUT, haversine } from './features.js';

const NEA = 'https://api-open.data.gov.sg/v2/real-time/api';
const REGIONS = ['north', 'south', 'east', 'west', 'central'];
const WX_VARS = { temp: 'temperature_2m', rh: 'relative_humidity_2m', precip: 'precipitation', wspd: 'wind_speed_10m', wdir: 'wind_direction_10m', blh: 'boundary_layer_height' };

export const sgtHourOf = ms => Math.floor(ms / 3600e3 + 8);          // UTC ms -> SGT hour number
const localStrToHour = s => Date.parse(s.length === 16 ? s + ':00Z' : s + 'Z') / 3600e3; // "YYYY-MM-DDTHH:MM" (already SGT)
const sgDate = off => new Date(Date.now() + 8 * 3600e3 + off * 86400e3).toISOString().slice(0, 10);

async function getJSON(url, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} from ${url.split('?')[0]}`); return await r.json(); }
    catch (e) { err = e; }
  }
  throw err;
}
const nanArr = n => new Array(n).fill(NaN);

// ---- NEA PM2.5: island-wide mean of the 5 regions (>=3 regions present) ----
async function pm25ForDate(date) {
  const items = []; let token;
  for (let i = 0; i < 6; i++) {
    const j = await getJSON(`${NEA}/pm25?date=${date}` + (token ? `&paginationToken=${token}` : ''));
    items.push(...(j.data.items || [])); token = j.data.paginationToken; if (!token) break;
  }
  return items;
}
export async function loadPm() {
  const days = await Promise.all([0, -1, -2, -3, -4].map(o => pm25ForDate(sgDate(o))));
  const byHour = new Map();
  for (const it of days.flat()) {
    const rd = it.readings?.pm25_one_hourly || {};
    const vals = REGIONS.map(r => rd[r]).filter(v => v != null && isFinite(v));
    if (vals.length >= 3) byHour.set(sgtHourOf(Date.parse(it.timestamp)), vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  if (!byHour.size) throw new Error('NEA returned no PM2.5 data');
  return byHour;
}

// ---- Open-Meteo weather (7 points) ----
export async function loadWeather(points, Hstart) {
  const names = Object.keys(points);
  const q = `latitude=${names.map(n => points[n][0]).join(',')}&longitude=${names.map(n => points[n][1]).join(',')}` +
    `&hourly=${Object.values(WX_VARS).join(',')}&wind_speed_unit=ms&timezone=Asia%2FSingapore&past_days=31&forecast_days=3`;
  let j = await getJSON(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!Array.isArray(j)) j = [j];
  const L = HIST + FUT, wx = Object.fromEntries(Object.keys(WX_VARS).map(k => [k, {}]));
  names.forEach((n, pi) => {
    const h = j[pi].hourly, t0 = h.time.map(localStrToHour);
    for (const [k, api] of Object.entries(WX_VARS)) {
      const arr = nanArr(L);
      h.time.forEach((_, i) => { const idx = t0[i] - Hstart; const v = h[api][i]; if (idx >= 0 && idx < L && v != null) arr[idx] = v; });
      wx[k][n] = arr;
    }
  });
  return wx;
}

// ---- Open-Meteo air-quality (CAMS) PM2.5 at upstream stations ----
export async function loadUpstream(stations, Hstart) {
  const names = Object.keys(stations);
  const q = `latitude=${names.map(n => stations[n][0]).join(',')}&longitude=${names.map(n => stations[n][1]).join(',')}` +
    `&hourly=pm2_5&timezone=Asia%2FSingapore&past_days=5&forecast_days=1`;
  let j = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`);
  if (!Array.isArray(j)) j = [j];
  const L = HIST + FUT, out = {};
  names.forEach((n, pi) => {
    const h = j[pi].hourly, arr = nanArr(L);
    h.time.forEach((t, i) => { const idx = localStrToHour(t) - Hstart; if (idx >= 0 && idx < L && h.pm2_5[i] != null) arr[idx] = h.pm2_5[i]; });
    out[n] = arr;
  });
  return out;
}

// ---- NASA FIRMS hotspots (last 5 days) ----
export async function loadHotspots(env, spec, Hstart) {
  const key = env.FIRMS_MAP_KEY;
  if (!key) throw new Error('FIRMS_MAP_KEY is not set');
  const src = env.FIRMS_SOURCE || 'VIIRS_SNPP_NRT';
  const [w, s, e, n] = spec.hotspot_bbox_wsen;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${src}/${w},${s},${e},${n}/5`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FIRMS ${r.status}`);
  const txt = await r.text();
  const lines = txt.trim().split('\n'); const head = lines.shift().split(',');
  if (!head.includes('latitude')) throw new Error('FIRMS: ' + txt.slice(0, 120));
  const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  const SRC = spec.source_points, L = HIST + FUT;
  const counts = Object.fromEntries(SRC.map(p => [p, new Array(L).fill(0)]));
  const dets = [];
  for (const ln of lines) {
    const c = ln.split(',');
    const conf = Number(c[col.confidence]);                 // 'l'/'n'/'h' (VIIRS) -> NaN -> kept, same as training
    if (c[col.confidence] !== '' && isFinite(conf) && conf < spec.hotspot_min_confidence) continue;
    const at = parseInt(c[col.acq_time], 10), lat = +c[col.latitude], lon = +c[col.longitude];
    const utc = Date.parse(c[col.acq_date] + 'T00:00:00Z') + (Math.floor(at / 100) * 60 + at % 100) * 60e3;
    const pos = sgtHourOf(utc + spec.hotspot_latency_h * 3600e3) - Hstart;
    if (pos < 0 || pos >= L) continue;
    let best = null, bd = 1e9;
    for (const p of SRC) { const d = haversine(lat, lon, ...spec.points[p]); if (d < bd) { bd = d; best = p; } }
    counts[best][pos]++;
    const frp = c[col.frp] === '' || c[col.frp] === undefined ? NaN : +c[col.frp];
    dets.push({ pos, lat, lon, frp });
  }
  return { counts, dets, source: src };
}
