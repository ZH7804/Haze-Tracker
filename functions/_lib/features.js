// Port of features.py (v6 model) for ONE origin hour, computed from live data.
// Time axis: integer "SGT hour numbers" (hours since epoch, shifted to Singapore time).
// Every window is strict like the Python version: any missing hour -> NaN.

const D2R = Math.PI / 180;
export const HIST = 744;        // hours of history kept (>= 720 for src_rain_30d)
export const FUT = 6;           // hours of forecast weather the model looks at
const WIND_WIN = 12, EXCESS_PM = 40, DECAY_KM = 800;
const ARR = { wind_avg_h: 6, idw_eps_km2: 1.0, along_min: 0.5, theta0_deg: 30.0, eta_max_h: 72.0, frp_default: 20.0, frp_cap: 500.0 };
const ARR_BINS = { arr_past6: [-6, 0], arr_0_1: [0, 1], arr_1_3: [1, 3], arr_3_6: [3, 6] };

export const haversine = (la1, lo1, la2, lo2) => {
  const p1 = la1 * D2R, p2 = la2 * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lo2 - lo1) * D2R / 2) ** 2;
  return 6371.0 * 2 * Math.asin(Math.sqrt(a));
};
export const bearing = (la1, lo1, la2, lo2) => {
  const p1 = la1 * D2R, p2 = la2 * D2R, dl = (lo2 - lo1) * D2R;
  const x = Math.sin(dl) * Math.cos(p2), y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(x, y) / D2R + 360) % 360;
};

// ---- strict window helpers on a plain array (NaN = missing) ----
const win = (a, end, n) => { let s = 0; for (let i = end - n + 1; i <= end; i++) { const v = a[i]; if (!(v === v) || v === undefined) return NaN; s += v; } return s; };
const wmean = (a, end, n) => win(a, end, n) / n;
const wsum = win;
const fwmean = (a, k, n) => { let s = 0; for (let i = k + 1; i <= k + n; i++) { const v = a[i]; if (!(v === v) || v === undefined) return NaN; s += v; } return s / n; };
const fwsum = (a, k, n) => fwmean(a, k, n) * n;
const l1p = Math.log1p;
const uvOf = (spd, dir) => [spd.map((s, i) => -s * Math.sin(dir[i] * D2R)), spd.map((s, i) => -s * Math.cos(dir[i] * D2R))];

/**
 * ctx = {
 *   I: origin index into the arrays (= HIST-1),
 *   hourSGT: SGT hour number of the origin (for doy/hod),
 *   pm: Float64Array/array of island-wide mean PM2.5 per hour (NaN missing), length >= I+1,
 *   wx: { temp, rh, precip, wspd, wdir, blh } each {pointName: array length I+1+FUT},
 *   counts: { sourcePoint: array } hotspot counts per hour (already latency-shifted, binned),
 *   dets: [{pos, lat, lon, frp}]  (pos = index on the same axis),
 *   upPm: { station: array } upstream PM2.5 (NaN missing) or null,
 *   spec: model.json spec block
 * }
 */
export function computeFeatures(ctx) {
  const { I, pm, wx, counts, dets, upPm, spec } = ctx;
  const POINTS = spec.points, SRC = spec.source_points, SG = POINTS.sg;
  const BEAR = spec.bearing_to_sg, DECAY = spec.decay;
  const UPS = spec.upstream_stations, UP_BEAR = spec.upstream_bearing, UP_DECAY = spec.upstream_decay;
  const F = {};

  // --- PM history ---
  const pmAt = (k) => wmean(pm, k, 1);
  F.pm_now = l1p(pmAt(I));
  const pm3 = k => wmean(pm, k, 3);
  F.pm_3h = l1p(pm3(I));
  F.pm_24h = l1p(wmean(pm, I, 24));
  F.pm_72h = l1p(wmean(pm, I, 72));
  F.pm_chg6 = l1p(pm3(I)) - l1p(pm3(I - 6));

  // --- Singapore weather ---
  const [u, v] = uvOf(wx.wspd.sg, wx.wdir.sg);
  F.sg_u = wmean(u, I, 6); F.sg_v = wmean(v, I, 6);
  F.sg_wspd = wmean(wx.wspd.sg, I, 6); F.sg_rh = wmean(wx.rh.sg, I, 6); F.sg_temp = wmean(wx.temp.sg, I, 6);
  F.sg_rain6 = l1p(wsum(wx.precip.sg, I, 6)); F.sg_rain24 = l1p(wsum(wx.precip.sg, I, 24));

  // --- source-region rain / humidity ---
  const avg = f => SRC.reduce((s, p) => s + f(p), 0) / SRC.length;
  F.src_rain_7d = l1p(avg(p => wsum(wx.precip[p], I, 168)));
  F.src_rain_30d = l1p(avg(p => wsum(wx.precip[p], I, 720)));
  F.src_rh_24h = avg(p => wmean(wx.rh[p], I, 24));

  // --- fires & wind push ---
  const fires24 = (p, k) => wsum(counts[p], k, 24);
  const proj = {}, proj_f = {}, uvp = {};
  for (const p of SRC) {
    const b = BEAR[p] * D2R;
    const [up, vp] = uvOf(wx.wspd[p], wx.wdir[p]); uvp[p] = [up, vp];
    proj[p] = up.map((x, i) => x * Math.sin(b) + vp[i] * Math.cos(b));
    const cr = up.map((x, i) => x * Math.cos(b) - vp[i] * Math.sin(b));
    proj[p].cross = cr;
  }
  const pushAt = k => SRC.reduce((s, p) => s + DECAY[p] * fires24(p, k) * Math.max(wmean(proj[p], k, WIND_WIN), 0), 0);
  F.fire_tot24 = l1p(SRC.reduce((s, p) => s + fires24(p, I), 0));
  F.fire_push = l1p(pushAt(I));
  F.fire_push_l24 = l1p(pushAt(I - 24));
  F.fire_push_l48 = l1p(pushAt(I - 48));
  let na = 0, nc = 0, den = 0;
  for (const p of SRC) {
    const w = DECAY[p] * fires24(p, I);
    na += w * wmean(proj[p], I, WIND_WIN); nc += w * wmean(proj[p].cross, I, WIND_WIN); den += w;
  }
  F.wind_along_fw = den === den ? (den > 0 ? na / den : 0) : NaN;
  F.wind_cross_fw = den === den ? (den > 0 ? nc / den : 0) : NaN;

  // --- forecast weather ---
  for (const n of [3, 6]) {
    F[`fut_u${n}`] = fwmean(u, I, n); F[`fut_v${n}`] = fwmean(v, I, n);
    F[`fut_push${n}`] = l1p(SRC.reduce((s, p) => s + DECAY[p] * fires24(p, I) * Math.max(fwmean(proj[p], I, n), 0), 0));
    F[`fut_rain${n}`] = l1p(fwsum(wx.precip.sg, I, n));
  }
  F.blh_now = l1p(wx.blh.sg[I]);
  F.fut_blh3 = l1p(fwmean(wx.blh.sg, I, 3)); F.fut_blh6 = l1p(fwmean(wx.blh.sg, I, 6));

  // --- calendar (SGT) ---
  const d = new Date(ctx.hourSGT * 3600e3);
  const doy = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400e3);
  const hod = d.getUTCHours();
  F.doy_sin = Math.sin(2 * Math.PI * doy / 365.25); F.doy_cos = Math.cos(2 * Math.PI * doy / 365.25);
  F.hod_sin = Math.sin(2 * Math.PI * hod / 24); F.hod_cos = Math.cos(2 * Math.PI * hod / 24);

  const ex = Math.max(F.pm_now - l1p(EXCESS_PM), 0);
  F.pm_excess = ex; F.ex_x_fire = ex * F.fire_push; F.ex_x_wind = ex * F.sg_wspd; F.ex_x_rain = ex * F.sg_rain6;
  F.ex_x_fpush6 = ex * F.fut_push6; F.ex_x_fblh6 = ex * F.fut_blh6;

  // --- per-detection arrival-time features ---
  const A = arrivalSums(dets, wx, I, POINTS, spec.arrival || ARR, DECAY_KM, SG);
  for (const k of Object.keys(ARR_BINS)) F[k] = l1p(A[k]);
  F.arr_next6 = l1p(A.arr_0_1 + A.arr_1_3 + A.arr_3_6);
  F.ex_x_arr6 = ex * F.arr_next6;

  // --- upstream stations ---
  if (upPm) {
    let tot = 0;
    for (const p of Object.keys(UPS)) {
      const b = UP_BEAR[p] * D2R;
      const along = u.map((x, i) => x * Math.sin(b) + v[i] * Math.cos(b));
      const pmp = upPm[p] ? upPm[p][I] : NaN;
      const push = UP_DECAY[p] * Math.max(pmp, 0) * Math.max(wmean(along, I, WIND_WIN), 0);
      tot += push;
      if (p === 'batam') { F.up_push_batam = l1p(push); F.up_grad_batam = l1p(pmp) - F.pm_now; }
      if (p === 'dumai') F.up_grad_dumai = l1p(pmp) - F.pm_now;
      if (p === 'pekanbaru') F.up_grad_pekanbaru = l1p(pmp) - F.pm_now;
    }
    F.up_push = l1p(tot);
  } else for (const k of ['up_push', 'up_push_batam', 'up_grad_batam', 'up_grad_dumai', 'up_grad_pekanbaru']) F[k] = NaN;
  return F;
}

// Sum of contributions active at the origin hour I for each arrival bin.
// Mirrors arrival_sums() in features.py (including the rain-washout term).
function arrivalSums(dets, wx, I, POINTS, ARRc, DECAY_KM, SG) {
  const names = Object.keys(POINTS), out = { arr_past6: 0, arr_0_1: 0, arr_1_3: 0, arr_3_6: 0 };
  const roll = (a, n, minp) => a.map((_, i) => { let s = 0, c = 0; for (let j = i - n + 1; j <= i; j++) { const x = a[j]; if (x === x && x !== undefined) { s += x; c++; } } return c >= minp ? s : NaN; });
  const U = {}, V = {}, R = {};
  for (const p of names) {
    const [u, v] = uvOf(wx.wspd[p], wx.wdir[p]);
    U[p] = roll(u, ARRc.wind_avg_h, ARRc.wind_avg_h).map(x => x / ARRc.wind_avg_h);
    V[p] = roll(v, ARRc.wind_avg_h, ARRc.wind_avg_h).map(x => x / ARRc.wind_avg_h);
    R[p] = roll(wx.precip[p], 3, 1);
  }
  for (const d of dets) {
    const pos = d.pos; if (pos < 0 || pos > I) continue;
    let sw = 0, su = 0, sv = 0, sr = 0;
    for (const p of names) {
      const dd = haversine(d.lat, d.lon, ...POINTS[p]), w = 1 / (dd * dd + ARRc.idw_eps_km2);
      sw += w; su += w * U[p][pos]; sv += w * V[p][pos]; sr += w * R[p][pos];
    }
    const u = su / sw, v = sv / sw, rain = sr / sw;
    const dist = haversine(d.lat, d.lon, ...SG), b = bearing(d.lat, d.lon, ...SG) * D2R;
    const along = u * Math.sin(b) + v * Math.cos(b), cross = u * Math.cos(b) - v * Math.sin(b);
    if (!(along > ARRc.along_min)) continue;
    const eta = dist / (3.6 * along);
    if (!(eta <= ARRc.eta_max_h) || !(rain === rain)) continue;
    const theta = Math.atan2(Math.abs(cross), along) / D2R;
    const f = Math.min(Math.max(d.frp === d.frp && d.frp != null ? d.frp : ARRc.frp_default, 0), ARRc.frp_cap);
    const c = f * Math.exp(-dist / DECAY_KM) * Math.exp(-((theta / ARRc.theta0_deg) ** 2)) * Math.exp(-rain / 2.0);
    const a = pos + eta;
    for (const [k, [lo, hi]] of Object.entries(ARR_BINS)) {
      const s0 = Math.max(Math.ceil(a - hi), pos), e0 = Math.ceil(a - lo);
      if (e0 > s0 && s0 <= I && I < e0) out[k] += c;
    }
  }
  return out;
}
