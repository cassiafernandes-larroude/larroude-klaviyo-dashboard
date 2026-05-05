// Vercel Edge Function — busca profile_count de UM segmento.
// Cada segmento tem seu próprio orçamento de 25s, sem competir com outros fetches.
// Cache de 24h por segmento (s-maxage=86400).
//
// Uso: GET /api/segment-count?id=XF8f94
// Resposta: { id: "XF8f94", count: 377204, fetchedAt: "..." } ou { id, count: null, error: "..." }
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

  try {
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

    if (!res.ok) {
      const text = await res.text();
      return new Response(JSON.stringify({
        id,
        count: null,
        error: "Klaviyo " + res.status + ": " + text.slice(0, 200),
        fetchedAt: new Date().toISOString()
      }), {
        status: 200, // sempre 200 para o frontend não falhar
        headers: {
          "content-type": "application/json",
          "cache-control": "public, s-maxage=300" // cache curto em caso de erro (5min)
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
        // Cache longo só se o count veio populado, senão cache curto pra tentar de novo logo
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
