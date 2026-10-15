// Runs one horizon's model (ridge or boosted trees) on a feature object.
// Output of every model is a CHANGE in log1p(PM2.5) relative to the current hour (see CONFIG below).

// ---- CONFIG: things model.json does not record. Confirm against train.py / forecast.js. ----
export const CONFIG = {
  // Haze-regime models are used when the 3h-mean PM2.5 (ug/m3) is at or above this.
  HAZE_GATE_PM3H: 25,
  // Target convention: prediction = log1p(pm_now) + model_output.
  ANCHOR: 'pm_now',
  // XGBoost base score is not in the tree dump; added to the summed tree outputs.
  XGB_BASE: 0,
};

const evalTree = (nodes, x) => {
  let i = 0;
  for (;;) {
    const [f, t, yes, no, miss] = nodes[i];
    if (f === -1) return t;
    const val = x[f];
    i = val === null || val === undefined || val !== val ? miss : (val < t ? yes : no);
  }
};

export function runEntry(e, F) {
  const x = e.features.map(n => F[n]);
  if (e.kind === 'ridge') {
    let s = e.intercept;
    for (let i = 0; i < x.length; i++) {
      const z = x[i] === x[i] ? (x[i] - e.mean[i]) / e.std[i] : 0;   // missing -> mean
      s += e.coef[i] * z;
    }
    return s;
  }
  return CONFIG.XGB_BASE + e.trees.reduce((s, t) => s + evalTree(t, x), 0);
}

import { explain } from './explain.js';

export function predictAll(model, F) {
  if (!(F.pm_now === F.pm_now)) throw new Error('no current PM2.5');
  const regime = Math.expm1(F.pm_3h) >= CONFIG.HAZE_GATE_PM3H ? 'haze' : 'clean';
  const base = F[CONFIG.ANCHOR];
  const out = {};
  for (const h of model.horizons) {
    const e = model.models[h][regime];
    const mid = base + runEntry(e, F);
    const g = z => Math.max(Math.expm1(z), 0);
    out[h] = { pm: g(mid), lo: g(mid + e.q10), hi: g(mid + e.q90), drivers: explain(e, F, model.ref[regime], base) };
  }
  return { regime, horizons: out };
}
