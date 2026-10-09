// Cloudflare Pages Function -> /api/air
// Proxies data.gov.sg and edge-caches for 5 min so you don't hit rate limits.
const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';

const sgDate = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

async function getJSON(url) {
  const r = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r.json();
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

export async function onRequestGet() {
  try {
    const [today, yesterday, psi] = await Promise.all([
      pm25ForDate(sgDate(0)),
      pm25ForDate(sgDate(-1)),
      getJSON(`${BASE}/psi`),
    ]);
    const hourly = [...yesterday, ...today]
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-26)
      .map(i => ({ t: i.timestamp, v: i.readings.pm25_one_hourly }));
    const p = psi.data.items[0];
    return new Response(JSON.stringify({
      hourly,
      psi24: p.readings.psi_twenty_four_hourly,
      pm25_24h: p.readings.pm25_twenty_four_hourly,
      psiUpdated: p.updatedTimestamp || p.timestamp,
    }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
