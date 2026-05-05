// Vercel Cron — disparado uma vez por dia às 03:00 ET.
// Função: aquecer o cache de /api/data e /api/performance pra que o primeiro usuário
// do dia já encontre tudo pronto, sem esperar a buscada longa do Klaviyo.

export const config = { runtime: "edge" };

export default async function handler(req) {
  // Vercel Cron envia header de autorização. Em prod, validar com process.env.CRON_SECRET.
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const baseUrl = "https://" + (req.headers.get("host") || "");
  const targets = [
    baseUrl + "/api/data",
    baseUrl + "/api/performance?days=7",
    baseUrl + "/api/performance?days=14",
    baseUrl + "/api/performance?days=28"
  ];

  const results = [];
  for (const url of targets) {
    try {
      const t0 = Date.now();
      // Cache-Control: no-cache para forçar refresh do cache da Vercel
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
      results.push({ url, status: res.status, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }

  return new Response(JSON.stringify({
    triggeredAt: new Date().toISOString(),
    results
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
