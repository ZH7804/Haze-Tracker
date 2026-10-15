const store = new Map();
globalThis.caches = { default: { match: async k => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } } };
const sg = ms => new Date(ms + 8*3600e3);
const nowMs = Date.now();
const hourStr = ms => sg(ms).toISOString().slice(0,13)+':00';
function nea(date){
  const items=[]; for(let h=0;h<24;h++){ const ts=Date.parse(date+'T00:00:00+08:00')+h*3600e3; if(ts>nowMs) break;
    items.push({timestamp:new Date(ts).toISOString().replace('Z','+08:00').replace(/T.*?\+/, m=>m), readings:{pm25_one_hourly:{north:20+h%5,south:25,east:22,west:30,central:24}}});
    items[items.length-1].timestamp = date+'T'+String(h).padStart(2,'0')+':00:00+08:00'; }
  return {data:{items}};
}
globalThis.fetch = async (url) => {
  url=String(url); const ok=b=>({ok:true,status:200,json:async()=>b,text:async()=>b});
  if(url.includes('/pm25')) return ok(nea(url.match(/date=([\d-]+)/)[1]));
  if(url.includes('api.open-meteo.com')||url.includes('air-quality-api')){
    const n=url.match(/latitude=([^&]+)/)[1].split(',').length; const aq=url.includes('air-quality');
    const t0=Math.floor(nowMs/3600e3)*3600e3+8*3600e3 - (aq?5:31)*86400e3 - ((Math.floor(nowMs/3600e3)*3600e3+8*3600e3)%86400e3);
    const len=aq?6*24:(31+3)*24; const time=[...Array(len)].map((_,i)=>hourStr(t0+i*3600e3-8*3600e3+8*3600e3-8*3600e3+8*3600e3));
    const mk=f=>[...Array(len)].map((_,i)=>f(i));
    return ok(JSON.stringify([...Array(n)].map(()=>({hourly:{time:time.map(s=>s.slice(0,16)),temperature_2m:mk(()=>28),relative_humidity_2m:mk(()=>80),precipitation:mk(i=>i%11?0:1),wind_speed_10m:mk(()=>3),wind_direction_10m:mk(i=>200+i%40),boundary_layer_height:mk(()=>700),pm2_5:mk(()=>35)}}))) ) && {ok:true,status:200,json:async()=>[...Array(n)].map(()=>({hourly:{time:time.map(s=>s.slice(0,16)),temperature_2m:mk(()=>28),relative_humidity_2m:mk(()=>80),precipitation:mk(i=>i%11?0:1),wind_speed_10m:mk(()=>3),wind_direction_10m:mk(i=>200+i%40),boundary_layer_height:mk(()=>700),pm2_5:mk(()=>35)}}))};
  }
  if(url.includes('firms')){
    const d=new Date(nowMs).toISOString().slice(0,10); let csv='latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n';
    for(let i=0;i<300;i++) csv+=`${(Math.random()*8-3).toFixed(3)},${(100+Math.random()*10).toFixed(3)},330,0.4,0.4,${d},${String(Math.floor(Math.random()*20)*100+30).padStart(4,'0')},N,VIIRS,${['l','n','h'][i%3]},2.0NRT,300,${(Math.random()*40).toFixed(1)},D\n`;
    return ok(csv);
  }
  throw new Error('unmocked '+url);
};
const { onRequestGet } = await import('./functions/api/forecast.js');
const bg=[];
const call=async q=>{const r=await onRequestGet({request:new Request('https://x.dev/api/forecast'+q),env:{FIRMS_MAP_KEY:'k'},waitUntil:p=>bg.push(p)});return [r.status,await r.json()];};
let [s,d]=await call('?debug=1'); console.log(s, JSON.stringify(d,(k,v)=>k==='features'?undefined:v).slice(0,900));
console.log('missing features:',d.missingFeatures);
[s,d]=await call(''); console.log('cached 2nd call', s, d.generatedAt, !!d.features);
