const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const RETRY_S = 120;        // while this hour's reading is still missing, re-check at most every 2 min
const PSI_GRACE_S = 600;    // accept a cached hour even if the 24h PSI hasn't updated after 10 min
const MAX_STALE_S = 6 * 3600; // serve stale for up to 6 h if NEA is unreachable
const sgHourOf = ms => Math.floor(ms / 3600e3 + 8);

const sgDate = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

async function getJSON(url, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} from ${url}`);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}

async function pm25ForDate(date) {
  const items = [];
  let token;
  for (let i = 0; i < 6; i++) {
    const j = await getJSON(`${BASE}/pm25?date=${date}` + (token ? `&paginationToken=${token}` : ''));
    items.push(...(j.data.items || []));
    token = j.data.paginationToken;
    if (!token) break;
  }
  return items;
}

async function build() {
  const [today, yesterday, dayBefore, psi] = await Promise.all([
    pm25ForDate(sgDate(0)), pm25ForDate(sgDate(-1)), pm25ForDate(sgDate(-2)), getJSON(`${BASE}/psi`),
  ]);
  const hourly = [...dayBefore, ...yesterday, ...today]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-48)
    .map(i => ({ t: i.timestamp, v: i.readings.pm25_one_hourly }));
  const p = psi.data.items[0];
  return {
    hourly,
    psi24: p.readings.psi_twenty_four_hourly,
    pm25_24h: p.readings.pm25_twenty_four_hourly,
    psiUpdated: p.updatedTimestamp || p.timestamp,
    fetchedAt: Date.now(),
  };
}

const out = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
});

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + '/__air_cache');
  const refresh = async () => {
    const data = await build();
    await cache.put(key, new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${MAX_STALE_S}` },
    }));
    return data;
  };

  const hit = await cache.match(key);
  if (hit) {
    const data = await hit.json();
    const nowH = sgHourOf(Date.now()), age = (Date.now() - data.fetchedAt) / 1000;
    const pmCurrent = !!data.hourly?.length && sgHourOf(Date.parse(data.hourly.at(-1).t)) >= nowH;
    const psiCurrent = !data.psiUpdated || sgHourOf(Date.parse(data.psiUpdated)) >= nowH;
    // This hour's reading is already loaded: no upstream calls until the hour turns over.
    if (pmCurrent && (psiCurrent || age > PSI_GRACE_S)) return out(data);
    if (age < RETRY_S) return out(data);                        // just checked; NEA may not have published yet
    try { return out(await refresh()); }                        // new hour started: fetch now and wait for it
    catch (e) { if (age < MAX_STALE_S) return out(data); return out({ error: String(e) }, 502); }
  }
  try { return out(await refresh()); }
  catch (e) { return out({ error: String(e) }, 502); }
}
