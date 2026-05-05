// Vercel Cron — disparado 1x por semana (Domingo 3am ET).
// Função: aquecer o cache de TODOS os endpoints pra que os usuários
// nunca esperem dados frescos do Klaviyo.

export const config = { runtime: "edge" };

// IDs dos segmentos featured (sempre warm)
const FEATURED_SEGMENT_IDS = [
  "XF8f94", "VzX6n5", "TKgWFC", "VDLdYZ", "QQPern",
  "TDXDzA", "WGrCjj", "RaXvQd", "Sudqwh"
];

export default async function handler(req) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const baseUrl = "https://" + (req.headers.get("host") || "");

  // 1. Bater /api/data primeiro (rápido, fornece a lista de flows e segments)
  const dataRes = await fetch(baseUrl + "/api/data", { headers: { "cache-control": "no-cache" } });
  let data = null;
  try { data = await dataRes.json(); } catch (_) {}

  const liveFlows = data && data.flows ? data.flows.filter(f => f.status === "live").map(f => f.id) : [];
  const allSegments = data && data.allSegments ? data.allSegments.map(s => s.id) : [];

  // 2. Combinar todas URLs de warmup (segments + featured + top live flows)
  const segmentSet = new Set([...FEATURED_SEGMENT_IDS, ...allSegments]);
  const targets = [
    baseUrl + "/api/data",
    ...Array.from(segmentSet).map(id => baseUrl + "/api/segment-count?id=" + id),
    ...liveFlows.flatMap(id => [
      baseUrl + "/api/flow-perf?id=" + id + "&days=7",
      baseUrl + "/api/flow-perf?id=" + id + "&days=14",
      baseUrl + "/api/flow-perf?id=" + id + "&days=28"
    ])
  ];

  // 3. Disparar TODAS em paralelo (não espera completar — cada uma cacheia individualmente)
  const fired = targets.map(url =>
    fetch(url, { headers: { "cache-control": "no-cache" } }).catch(() => null)
  );

  // Espera no máximo 20s pra retornar (cron tem 25s no Hobby)
  await Promise.race([
    Promise.all(fired),
    new Promise(r => setTimeout(r, 20000))
  ]);

  return new Response(JSON.stringify({
    triggeredAt: new Date().toISOString(),
    targetCount: targets.length,
    liveFlowCount: liveFlows.length,
    segmentCount: segmentSet.size
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
