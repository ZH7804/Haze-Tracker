// GET /api/forecast  ->  1/2/3/6/24-hour island-wide PM2.5 forecast with an 80% interval.
// Recomputed at most once per clock hour (cached at the edge); the page just polls this endpoint.
import MODEL from '../_lib/model.json';
import { computeFeatures, HIST, FUT } from '../_lib/features.js';
import { predictAll, CONFIG } from '../_lib/model.js';
import { loadPm, loadWeather, loadUpstream, loadHotspots, sgtHourOf } from '../_lib/sources.js';

const SCHEMA = 3;             // bump when the response format changes: older cached forecasts are rebuilt
const RETRY_S = 120;          // origin hour not published yet -> retry every 2 min
const MAX_STALE_S = 6 * 3600; // serve the last good forecast for up to 6 h if sources are down

const ffill = (a, maxGap) => { let last = NaN, gap = 0; return a.map(v => { if (v === v) { last = v; gap = 0; return v; } return ++gap <= maxGap && last === last ? last : NaN; }); };
const iso = H => new Date(H * 3600e3 - 8 * 3600e3).toISOString().replace('Z', '+00:00'); // SGT hour number -> UTC ISO

async function build(env) {
  const spec = MODEL.spec, S = {};
  // Each source reports its own status; required ones fail the forecast, optional ones degrade it.
  const run = async (key, label, role, required, fn) => {
    const t0 = Date.now();
    try { const v = await fn(); S[key] = { label, role, required, ok: true, ms: Date.now() - t0 }; return v; }
    catch (e) { S[key] = { label, role, required, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 160) }; return null; }
  };
  const fail = () => {
    const bad = Object.values(S).filter(x => !x.ok && !x.skipped && x.required).map(x => `${x.label}: ${x.error}`);
    const err = new Error(bad.join('; ') || 'unknown failure'); err.sources = S; throw err;
  };
  const skip = (key, label, role, required) => { S[key] = { label, role, required, ok: false, skipped: true, error: 'not attempted' }; };
  const ROLE = { pm: 'Starting point and recent history', wx: 'Wind, rain, humidity and mixing height', aq: 'Smoke levels at upstream stations (Sumatra, Batam, Kalimantan)', fire: 'Satellite fire detections' };

  const pmMap = await run('nea_pm', 'NEA PM2.5 readings', ROLE.pm, true, loadPm);
  if (!pmMap) { skip('open_meteo_wx', 'Open-Meteo weather', ROLE.wx, true); skip('open_meteo_aq', 'Open-Meteo air quality', ROLE.aq, false); skip('nasa_firms', 'NASA FIRMS fires', ROLE.fire, true); fail(); }
  const originH = Math.max(...pmMap.keys());
  S.nea_pm.detail = `${pmMap.size} hourly readings, latest ${new Date(originH * 3600e3 - 8 * 3600e3).toLocaleTimeString('en-SG', { hour: 'numeric', timeZone: 'Asia/Singapore' })}`;
  const Hstart = originH - (HIST - 1), I = HIST - 1, L = HIST + FUT;
  const pmRaw = new Array(L).fill(NaN);
  for (const [h, v] of pmMap) { const k = h - Hstart; if (k >= 0 && k < L) pmRaw[k] = v; }
  const pm = ffill(pmRaw.slice(0, I + 1), 2);                // bridge short NEA gaps (<=2 h)

  const [wx, upPm, hs] = await Promise.all([
    run('open_meteo_wx', 'Open-Meteo weather', ROLE.wx, true, () => loadWeather(spec.points, Hstart)),
    run('open_meteo_aq', 'Open-Meteo air quality', ROLE.aq, false, () => loadUpstream(spec.upstream_stations, Hstart)),
    run('nasa_firms', 'NASA FIRMS fires', ROLE.fire, true, () => loadHotspots(env, spec, Hstart)),
  ]);
  if (wx) S.open_meteo_wx.detail = `${Object.keys(spec.points).length} locations, ${wx._era5 ? 'ERA5 history + forecast' : 'forecast data only (ERA5 archive unavailable)'}`;
  if (upPm) { const n = Object.values(upPm).filter(a => a[I] === a[I]).length; S.open_meteo_aq.detail = `${n} of ${Object.keys(upPm).length} stations reporting`; if (!n) S.open_meteo_aq.degraded = true; }
  else S.open_meteo_aq.degraded = true;
  if (hs) S.nasa_firms.detail = `${hs.dets.length} hotspots in last 5 days (${hs.source})`;
  if (!wx || !hs) fail();

  const F = computeFeatures({ I, hourSGT: originH, pm, wx, counts: hs.counts, dets: hs.dets, upPm, spec });
  const missing = MODEL.features.filter(f => !(F[f] === F[f]));
  const { regime, horizons } = predictAll(MODEL, F);
  return {
    schema: SCHEMA, modelVersion: MODEL.version, trainedAt: MODEL.trained_at, interval: 0.8, regime,
    origin: iso(originH), generatedAt: new Date(Date.now()).toISOString(), generatedHour: sgtHourOf(Date.now()),
    originHour: originH, nowPm: Math.expm1(F.pm_now), hotspotSource: hs.source,
    missingFeatures: missing, sources: S,
    horizons: MODEL.horizons.map(h => ({ h, time: iso(originH + h), ...horizons[h], mae: MODEL.metrics[h].mae_model })),
    _features: F,
  };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url), debug = url.searchParams.has('debug');
  const cache = caches.default, key = new Request(url.origin + '/__forecast_cache');
  const strip = d => { const { _features, ...rest } = d; return debug ? { ...rest, features: _features, config: CONFIG } : rest; };
  const refresh = async () => {
    const d = await build(env);
    await cache.put(key, new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${MAX_STALE_S}` } }));
    return d;
  };

  const hit = await cache.match(key);
  const old = hit ? await hit.json() : null;
  if (old && old.schema === SCHEMA) {
    const d = old;
    const nowH = sgtHourOf(Date.now()), age = (Date.now() - Date.parse(d.generatedAt)) / 1000;
    if (d.originHour >= nowH) return json(strip(d));            // already has this hour's NEA reading
    if (age < RETRY_S) return json(strip(d));                   // just tried; NEA may not have published yet
    try { return json(strip(await refresh())); }                // behind the clock: rebuild now and wait for it
    catch (e) { if (age < MAX_STALE_S) return json({ ...strip(d), stale: true, refreshError: String(e.message || e), liveSources: e.sources }); return json({ error: String(e.message || e), sources: e.sources }, 502); }
  }
  try { return json(strip(await refresh())); }
  catch (e) { return json({ error: String(e.message || e), sources: e.sources }, 502); }
}

