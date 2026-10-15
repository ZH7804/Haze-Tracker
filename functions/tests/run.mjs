import fs from 'fs';
import { computeFeatures } from '/home/claude/site/functions/_lib/features.js';
const model=JSON.parse(fs.readFileSync('/home/claude/site/functions/_lib/model.json'));
const c=JSON.parse(fs.readFileSync('case.json'));
const F=computeFeatures({I:c.I,hourSGT:c.hourSGT,pm:c.pm,wx:c.wx,counts:c.counts,dets:c.dets.map(d=>({...d,frp:d.frp===null?NaN:d.frp})),upPm:c.up,spec:model.spec});
let bad=0,n=0;
for(const [k,e] of Object.entries(c.expected)){ const g=F[k]; n++;
  const ok = e===null? !(g===g) : Math.abs(g-e)<=1e-6*Math.max(1,Math.abs(e));
  if(!ok){bad++;console.log('MISMATCH',k,'py',e,'js',g);} }
console.log(`${n-bad}/${n} features match`);
