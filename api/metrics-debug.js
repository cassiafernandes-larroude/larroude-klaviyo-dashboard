// Debug endpoint — lista todas as métricas de uma conta para descobrir o ID de "Placed Order".
// Uso: GET /api/metrics-debug?account=br|us

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

function getApiKey(account) {
  if (account === "br") return process.env.KLAVIYO_API_KEY_BR;
  return process.env.KLAVIYO_API_KEY_US || process.env.KLAVIYO_API_KEY;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const account = (url.searchParams.get("account") || "us").toLowerCase();
  const apiKey = getApiKey(account);
  if (!apiKey) return new Response(JSON.stringify({ error: "no api key for " + account }), { status: 500, headers: { "content-type": "application/json" } });

  try {
    const all = [];
    let nextUrl = "/metrics?fields[metric]=name,integration";
    let safety = 5;
    while (nextUrl && safety-- > 0) {
      const res = await fetch(KLAVIYO_BASE + nextUrl, {
        headers: { "Authorization": "Klaviyo-API-Key " + apiKey, "accept": "application/json", "revision": REVISION }
      });
      if (!res.ok) {
        const t = await res.text();
        return new Response(JSON.stringify({ error: res.status + ": " + t.slice(0, 300) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const j = await res.json();
      (j.data || []).forEach(m => {
        all.push({
          id: m.id,
          name: m.attributes && m.attributes.name,
          integration: m.attributes && m.attributes.integration && m.attributes.integration.name
        });
      });
      nextUrl = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
    }
    const orderRelated = all.filter(m => {
      const n = (m.name || "").toLowerCase();
      return n.includes("placed") || n.includes("order") || n.includes("pedido") || n.includes("compra") || n.includes("checkout") || n.includes("purchase");
    });
    return new Response(JSON.stringify({
      account,
      total: all.length,
      orderRelated,
      all
    }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
