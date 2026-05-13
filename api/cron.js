// Vercel Cron — diário, aquece cache de US E BR.
// Estratégia: 1) /api/data 2) /api/performance (1 batch com TODOS flows)
// 3) /api/segment-count featured + rotação 1/3 dos demais. Tudo fire-and-forget.

export const config = { runtime: "edge" };

const FEATURED_SEGMENT_IDS_US = [
  "XF8f94", "VzX6n5", "TKgWFC", "VDLdYZ", "QQPern",
  "TDXDzA", "WGrCjj", "RaXvQd", "Sudqwh"
];

const FEATURED_SEGMENT_IDS_BR = [
  "V7SkpA", "RxfYKt", "SgCgbU", "XcbwM2", "Ta4EnS", "RFyTVT"
];

export default async function handler(req) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const baseUrl = "https://" + (req.headers.get("host") || "");

  async function warmAccount(acct) {
    const dataRes = await fetch(baseUrl + "/api/data?account=" + acct + "&_warm=1").catch(() => null);
    let allSegmentIds = [];
    let liveFlowIds = [];
    if (dataRes && dataRes.ok) {
      try {
        const data = await dataRes.json();
        allSegmentIds = data && data.allSegments ? data.allSegments.map(s => s.id) : [];
        liveFlowIds = data && data.flows ? data.flows.filter(f => f.status === "live").map(f => f.id) : [];
      } catch (_) {}
    }

    // 1 chamada batched de performance — pega TODOS flows
    const perfTarget = baseUrl + "/api/performance?days=7&account=" + acct;

    const featuredIds = acct === "us" ? FEATURED_SEGMENT_IDS_US : FEATURED_SEGMENT_IDS_BR;
    const dayBucket = Math.floor(Date.now() / 86400000) % 3;
    const segChunkSize = Math.max(1, Math.ceil(allSegmentIds.length / 3));
    const segChunkStart = dayBucket * segChunkSize;
    const segChunk = allSegmentIds.slice(segChunkStart, segChunkStart + segChunkSize);

    // Shopify attribution — últimos 3 meses
    const now = new Date();
    const shopifyMonths = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      shopifyMonths.push(d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"));
    }

    const targets = [
      perfTarget,
      // LTV windows (BigQuery) — 3 janelas
      baseUrl + "/api/ltv-windows?days=90&account=" + acct,
      baseUrl + "/api/ltv-windows?days=180&account=" + acct,
      baseUrl + "/api/ltv-windows?days=365&account=" + acct,
      // Campaign revenue por audiência (top segmentos v2) — 7/28d
      baseUrl + "/api/campaign-revenue?days=7&account=" + acct,
      baseUrl + "/api/campaign-revenue?days=28&account=" + acct,
      ...featuredIds.map(id => baseUrl + "/api/segment-count?id=" + id + "&account=" + acct),
      ...segChunk.map(id => baseUrl + "/api/segment-count?id=" + id + "&account=" + acct),
      ...liveFlowIds.map(id => baseUrl + "/api/flow-trigger?id=" + id + "&account=" + acct),
      ...liveFlowIds.map(id => baseUrl + "/api/flow-messages?id=" + id + "&account=" + acct),
      ...shopifyMonths.map(m => baseUrl + "/api/shopify-attribution?account=" + acct + "&month=" + m)
    ];
    targets.forEach(url => { fetch(url).catch(() => null); });

    return { acct, target: targets.length, perf: 1, featured: featuredIds.length, segChunk: segChunk.length, flowTriggers: liveFlowIds.length, shopifyMonths: shopifyMonths.length, totalSegments: allSegmentIds.length };
  }

  const us = await warmAccount("us");
  const br = process.env.KLAVIYO_API_KEY_BR ? await warmAccount("br") : null;

  return new Response(JSON.stringify({
    triggeredAt: new Date().toISOString(),
    us, br
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
