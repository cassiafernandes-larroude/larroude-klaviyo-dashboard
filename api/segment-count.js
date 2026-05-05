// Vercel Edge Function — busca profile_count de UM segmento.
// Cada segmento tem seu próprio orçamento de 25s, sem competir com outros fetches.
// Inclui retry com backoff em caso de 429 (rate limit do Klaviyo).
// Cache de 24h por segmento (s-maxage=86400).
//
// Uso: GET /api/segment-count?id=XF8f94
// Resposta: { id, name, count, fetchedAt } ou { id, count: null, error }
//
// Env var: KLAVIYO_API_KEY

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (!id || !/^[A-Za-z0-9]+$/.test(id)) {
    return new Response(JSON.stringify({ error: "missing or invalid id param" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }

  // Retry com backoff em caso de 429 (rate limit do Klaviyo)
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
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    return last;
  }

  try {
    const res = await fetchWithRetry(5);

    if (!res || !res.ok) {
      const text = res ? await res.text() : "no response";
      return new Response(JSON.stringify({
        id,
        count: null,
        error: "Klaviyo " + (res ? res.status : "?") + ": " + text.slice(0, 200),
        fetchedAt: new Date().toISOString()
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, s-maxage=300"
        }
      });
    }

    const j = await res.json();
    const count = j.data && j.data.attributes && typeof j.data.attributes.profile_count === "number"
      ? j.data.attributes.profile_count
      : null;
    const name = j.data && j.data.attributes && j.data.attributes.name;

    return new Response(JSON.stringify({
      id,
      name,
      count,
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": count !== null
          ? "public, s-maxage=86400, stale-while-revalidate=3600"
          : "public, s-maxage=300"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      id,
      count: null,
      error: e.message || String(e),
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=60"
      }
    });
  }
}
