// Vercel Edge Function — busca profile_count de UM segmento.
// Suporta ?account=us|br. Cache 7 dias por (account, id).

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

function getApiKey(account) {
  if (account === "br") return process.env.KLAVIYO_API_KEY_BR;
  return process.env.KLAVIYO_API_KEY_US || process.env.KLAVIYO_API_KEY;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const account = (url.searchParams.get("account") || "us").toLowerCase();

  if (!id || !/^[A-Za-z0-9]+$/.test(id)) {
    return new Response(JSON.stringify({ error: "missing or invalid id" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (account !== "us" && account !== "br") {
    return new Response(JSON.stringify({ error: "account inválida" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const apiKey = getApiKey(account);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY_" + account.toUpperCase() + " não configurada" }), { status: 500, headers: { "content-type": "application/json" } });
  }

  async function fetchWithRetry(maxAttempts) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(
        KLAVIYO_BASE + "/segments/" + encodeURIComponent(id) + "?additional-fields[segment]=profile_count",
        {
          headers: {
            "Authorization": "Klaviyo-API-Key " + apiKey,
            "accept": "application/json",
            "revision": REVISION
          }
        }
      );
      if (res.ok) return res;
      if (res.status !== 429) return res;
      const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      last = res;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, waitMs));
    }
    return last;
  }

  try {
    const res = await fetchWithRetry(8);
    if (!res || !res.ok) {
      const text = res ? await res.text() : "no response";
      return new Response(JSON.stringify({
        id, account, count: null,
        error: "Klaviyo " + (res ? res.status : "?") + ": " + text.slice(0, 200),
        fetchedAt: new Date().toISOString()
      }), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=300" } });
    }
    const j = await res.json();
    const count = j.data && j.data.attributes && typeof j.data.attributes.profile_count === "number" ? j.data.attributes.profile_count : null;
    const name = j.data && j.data.attributes && j.data.attributes.name;
    return new Response(JSON.stringify({ id, account, name, count, fetchedAt: new Date().toISOString() }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": count !== null ? "public, s-maxage=604800, stale-while-revalidate=86400" : "public, s-maxage=300"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ id, account, count: null, error: e.message, fetchedAt: new Date().toISOString() }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60" }
    });
  }
}
