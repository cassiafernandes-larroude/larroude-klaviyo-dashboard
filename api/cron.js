// Vercel Cron — disparado 1x por dia (7 UTC = 3am ET).
// Estratégia: rotacionar chunks + fire-and-forget paralelo.
// Cada endpoint tem seu próprio Edge function (25s budget) com retry interno.

export const config = { runtime: "edge" };

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

  // 1. Warmup /api/data (geralmente rápido, vai para cache)
  const dataPromise = fetch(baseUrl + "/api/data?_warm=1").catch(() => null);

  // 2. Pegar lista pra rotação (timeout de 5s, senão usa só featured)
  let liveFlows = [];
  let allSegmentIds = [];
  try {
    const dataRes = await Promise.race([
      dataPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))
    ]);
    if (dataRes && dataRes.ok) {
      const data = await dataRes.json();
      liveFlows = data && data.flows ? data.flows.filter(f => f.status === "live").map(f => f.id) : [];
      allSegmentIds = data && data.allSegments ? data.allSegments.map(s => s.id) : [];
    }
  } catch (_) {}

  // Rotação por dia
  const dayBucket = Math.floor(Date.now() / 86400000) % 7;
  const segChunkSize = Math.max(1, Math.ceil(allSegmentIds.length / 4));
  const segChunkStart = (dayBucket % 4) * segChunkSize;
  const segChunk = allSegmentIds.slice(segChunkStart, segChunkStart + segChunkSize);

  const flowChunkSize = Math.max(1, Math.ceil(liveFlows.length / 2));
  const flowChunkStart = (dayBucket % 2) * flowChunkSize;
  const flowChunk = liveFlows.slice(flowChunkStart, flowChunkStart + flowChunkSize);

  // 3. Fire-and-forget em PARALELO (cada endpoint tem seu próprio 25s)
  const targets = [
    ...FEATURED_SEGMENT_IDS.map(id => baseUrl + "/api/segment-count?id=" + id),
    ...segChunk.map(id => baseUrl + "/api/segment-count?id=" + id),
    ...flowChunk.map(id => baseUrl + "/api/flow-perf?id=" + id + "&days=7")
  ];

  // Dispara todos sem await
  targets.forEach(url => {
    fetch(url).catch(() => null);
  });

  // Retorna imediatamente (cron termina, mas as fetches continuam no background da Vercel)
  return new Response(JSON.stringify({
    triggeredAt: new Date().toISOString(),
    dayBucket,
    targetCount: targets.length,
    featuredCount: FEATURED_SEGMENT_IDS.length,
    segChunkCount: segChunk.length,
    flowChunkCount: flowChunk.length
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
