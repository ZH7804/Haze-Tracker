// GET /api/forecast  ->  1/2/3/6/24-hour island-wide PM2.5 forecast with an 80% interval.
// Recomputed at most once per clock hour (cached at the edge); the page just polls this endpoint
import MODEL from '../_lib/model.json';
import { computeFeatures, HIST, FUT } from '../_lib/features.js';
import { predictAll, CONFIG } from '../_lib/model.js';
import { loadPm, loadWeather, loadUpstream, loadHotspots, sgtHourOf } from '../_lib/sources.js';

const RETRY_S = 600;          // origin hour not published yet -> retry every 10 min
const MAX_STALE_S = 6 * 3600; // serve the last good forecast for up to 6 h if sources are down

const ffill = (a, maxGap) => { let last = NaN, gap = 0; return a.map(v => { if (v === v) { last = v; gap = 0; return v; } return ++gap <= maxGap && last === last ? last : NaN; }); };
const iso = H => new Date(H * 3600e3 - 8 * 3600e3).toISOString().replace('Z', '+00:00'); // SGT hour number -> UTC ISO

async function build(env) {
  const spec = MODEL.spec;
  const pmMap = await loadPm();
  const originH = Math.max(...pmMap.keys());
  const Hstart = originH - (HIST - 1), I = HIST - 1, L = HIST + FUT;
  const pmRaw = new Array(L).fill(NaN);
  for (const [h, v] of pmMap) { const k = h - Hstart; if (k >= 0 && k < L) pmRaw[k] = v; }
  const pm = ffill(pmRaw.slice(0, I + 1), 2);                // bridge short NEA gaps (<=2 h)

  const [wx, upPm, hs] = await Promise.all([
    loadWeather(spec.points, Hstart), loadUpstream(spec.upstream_stations, Hstart), loadHotspots(env, spec, Hstart),
  ]);
  const F = computeFeatures({ I, hourSGT: originH, pm, wx, counts: hs.counts, dets: hs.dets, upPm, spec });
  const missing = MODEL.features.filter(f => !(F[f] === F[f]));
  const { regime, horizons } = predictAll(MODEL, F);
  return {
    modelVersion: MODEL.version, trainedAt: MODEL.trained_at, interval: 0.8, regime,
    origin: iso(originH), generatedAt: new Date().toISOString(), generatedHour: sgtHourOf(Date.now()),
    originHour: originH, nowPm: Math.expm1(F.pm_now), hotspotSource: hs.source,
    missingFeatures: missing,
    horizons: MODEL.horizons.map(h => ({ h, time: iso(originH + h), ...horizons[h], mae: MODEL.metrics[h].mae_model })),
    _features: F,
  };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } });

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
  if (hit) {
    const d = await hit.json();
    const nowH = sgtHourOf(Date.now()), age = (Date.now() - Date.parse(d.generatedAt)) / 1000;
    const current = d.originHour >= nowH - 0 || (d.generatedHour === nowH && age < RETRY_S);
    if (current) return json(strip(d));
    if (age < MAX_STALE_S) {                                    // stale-while-revalidate
      waitUntil(refresh().catch(() => {}));
      return json(strip(d));
    }
  }
  try { return json(strip(await refresh())); }
  catch (e) { return json({ error: String(e.message || e) }, 502); }
}
