// Vercel Cron — disparado uma vez por dia às 03:00 ET.
// Função: aquecer o cache de /api/data, /api/performance e /api/segment-count
// pra que o primeiro usuário do dia já encontre tudo pronto.

export const config = { runtime: "edge" };

// IDs dos segmentos featured (mantidos em sync com api/data.js e index.html)
const FEATURED_SEGMENT_IDS = [
  "XF8f94", "VzX6n5", "TKgWFC", "VDLdYZ", "QQPern",
  "TDXDzA", "WGrCjj", "RaXvQd", "Sudqwh"
];

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
    baseUrl + "/api/performance?days=28",
    // 9 segmentos individuais — cada um aquece seu próprio cache de 24h
    ...FEATURED_SEGMENT_IDS.map(id => baseUrl + "/api/segment-count?id=" + id)
  ];

  // Hit em paralelo (são endpoints independentes, sem race entre si)
  const results = await Promise.all(targets.map(async (url) => {
    try {
      const t0 = Date.now();
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
      return { url, status: res.status, ms: Date.now() - t0 };
    } catch (e) {
      return { url, error: e.message };
    }
  }));

  return new Response(JSON.stringify({
    triggeredAt: new Date().toISOString(),
    results
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
