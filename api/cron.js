// Vercel Cron — rodando 1x por dia (7 UTC = 3am ET).
// Estratégia: rotacionar quais endpoints aquecer cada dia, pra cobrir TUDO em ~3 dias.
// Cache TTL = 7 dias, então depois de 3-7 dias tudo está sempre quente.

export const config = { runtime: "edge" };

const FEATURED_SEGMENT_IDS = [
  "XF8f94", "VzX6n5", "TKgWFC", "VDLdYZ", "QQPern",
  "TDXDzA", "WGrCjj", "RaXvQd", "Sudqwh"
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default async function handler(req) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const baseUrl = "https://" + (req.headers.get("host") || "");

  // 1. Bater /api/data (rápido, traz lista completa de flows e segments)
  const dataRes = await fetch(baseUrl + "/api/data?_warm=1", { headers: { "cache-control": "no-cache" } });
  let data = null;
  try { data = await dataRes.json(); } catch (_) {}

  const liveFlows = data && data.flows ? data.flows.filter(f => f.status === "live").map(f => f.id) : [];
  const allSegmentIds = data && data.allSegments ? data.allSegments.map(s => s.id) : [];

  // Rotação por dia do ano: cada dia warm um chunk diferente
  // 7 days × 40 endpoints = 280 endpoints/semana, cobre todos os ~150 endpoints
  const dayOfYear = Math.floor((Date.now() / 86400000)) % 7; // 0..6
  const chunkSize = Math.ceil(allSegmentIds.length / 4); // 4 chunks de segments
  const segChunkStart = (dayOfYear % 4) * chunkSize;
  const segChunk = allSegmentIds.slice(segChunkStart, segChunkStart + chunkSize);

  const flowChunkSize = Math.ceil(liveFlows.length / 2);
  const flowChunkStart = (dayOfYear % 2) * flowChunkSize;
  const flowChunk = liveFlows.slice(flowChunkStart, flowChunkStart + flowChunkSize);

  // SEMPRE warm os 9 featured + chunk rotativo
  const targets = [
    ...FEATURED_SEGMENT_IDS.map(id => baseUrl + "/api/segment-count?id=" + id),
    ...segChunk.map(id => baseUrl + "/api/segment-count?id=" + id),
    ...flowChunk.map(id => baseUrl + "/api/flow-perf?id=" + id + "&days=7")
  ];

  // Sequencial com 400ms delay (não espera response — fire-and-forget)
  const startedAt = Date.now();
  const fired = [];
  for (let i = 0; i < targets.length && Date.now() - startedAt < 22000; i++) {
    fired.push(fetch(targets[i], { headers: { "cache-control": "no-cache" } }).catch(() => null));
    await sleep(400);
  }

  return new Response(JSON.stringify({
    triggeredAt: new Date().toISOString(),
    dayOfYear,
    targetCount: targets.length,
    firedCount: fired.length,
    durationMs: Date.now() - startedAt,
    featuredCount: FEATURED_SEGMENT_IDS.length,
    segChunkCount: segChunk.length,
    flowChunkCount: flowChunk.length
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
