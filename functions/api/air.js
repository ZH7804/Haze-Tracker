const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const FRESH_S = 300;        // treat as fresh for 5 min
const MAX_STALE_S = 6 * 3600; // serve stale for up to 6 h while revalidating

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
    const age = (Date.now() - data.fetchedAt) / 1000;
    if (age >= FRESH_S) waitUntil(refresh().catch(() => {}));
    return out(data);
  }
  try { return out(await refresh()); }
  catch (e) { return out({ error: String(e) }, 502); }
}
