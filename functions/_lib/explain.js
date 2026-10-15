// "What is driving the forecast?" Group-ablation attribution.
// For each group of inputs we replace its values with the typical value for the active regime
// (training mean) and see how much the forecast moves. Positive effect = the group pushes the
// forecast UP relative to a typical hour. Current air quality (PM history) is deliberately excluded.
import { runEntry } from './model.js';

export const GROUPS = [
  { key: 'wind_fires', label: 'Wind carrying fire smoke toward Singapore',
    f: ['fire_push', 'fire_push_l24', 'fire_push_l48', 'wind_along_fw', 'wind_cross_fw', 'fut_push3', 'fut_push6', 'ex_x_fire', 'ex_x_fpush6'] },
  { key: 'arrival', label: 'Smoke from fires expected to arrive soon',
    f: ['arr_past6', 'arr_0_1', 'arr_1_3', 'arr_3_6', 'arr_next6', 'ex_x_arr6', 'fire_tot24'] },
  { key: 'upstream', label: 'Smoke over nearby Sumatra and Batam',
    f: ['up_push', 'up_push_batam', 'up_grad_batam', 'up_grad_dumai', 'up_grad_pekanbaru'] },
  { key: 'rain', label: 'Rain in Singapore',
    f: ['sg_rain6', 'sg_rain24', 'fut_rain3', 'fut_rain6', 'ex_x_rain'] },
  { key: 'dryness', label: 'Dry or wet spell in the fire regions',
    f: ['src_rain_7d', 'src_rain_30d', 'src_rh_24h'] },
  { key: 'mixing', label: 'Mixing height (how much the air can disperse)',
    f: ['blh_now', 'fut_blh3', 'fut_blh6', 'ex_x_fblh6'] },
  { key: 'wind', label: 'Local wind in Singapore',
    f: ['sg_u', 'sg_v', 'sg_wspd', 'fut_u3', 'fut_v3', 'fut_u6', 'fut_v6', 'ex_x_wind'] },
  { key: 'weather', label: 'Humidity and temperature', f: ['sg_rh', 'sg_temp'] },
  { key: 'time', label: 'Time of day and season', f: ['doy_sin', 'doy_cos', 'hod_sin', 'hod_cos'] },
];
// current air quality: not reported as a "factor"
export const EXCLUDED = ['pm_now', 'pm_3h', 'pm_24h', 'pm_72h', 'pm_chg6', 'pm_excess'];

const DERIVED = { ex_x_fire: 'fire_push', ex_x_wind: 'sg_wspd', ex_x_rain: 'sg_rain6', ex_x_fpush6: 'fut_push6', ex_x_fblh6: 'fut_blh6', ex_x_arr6: 'arr_next6' };

export function explain(entry, F, ref, anchor, top = 3) {
  const g = z => Math.max(Math.expm1(z), 0);
  const actual = g(anchor + runEntry(entry, F));
  const out = [];
  for (const grp of GROUPS) {
    const F2 = { ...F };
    for (const f of grp.f) if (ref[f] !== undefined) F2[f] = ref[f];
    for (const [d, b] of Object.entries(DERIVED)) F2[d] = F2.pm_excess * F2[b];   // keep interactions consistent
    const alt = g(anchor + runEntry(entry, F2));
    out.push({ key: grp.key, label: grp.label, effectPm: actual - alt });
  }
  return out.sort((a, b) => Math.abs(b.effectPm) - Math.abs(a.effectPm)).slice(0, top)
    .map(x => ({ ...x, effectPm: Math.round(x.effectPm * 100) / 100 }));
}
