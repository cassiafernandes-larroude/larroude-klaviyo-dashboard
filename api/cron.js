// Vercel Cron — diário, aquece cache de US E BR.

export const config = { runtime: "edge" };

const FEATURED_SEGMENT_IDS_US = [
  "XF8f94", "VzX6n5", "TKgWFC", "VDLdYZ", "QQPern",
  "TDXDzA", "WGrCjj", "RaXvQd", "Sudqwh"
];

export default async function handler(req) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== "Bearer " + process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const baseUrl = "https://" + (req.headers.get("host") || "");
  const dayBucket = Math.floor(Date.now() / 86400000) % 7;

  async function warmAccount(acct) {
    const dataRes = await fetch(baseUrl + "/api/data?account=" + acct + "&_warm=1").catch(() => null);
    let liveFlows = [], allSegmentIds = [];
    if (dataRes && dataRes.ok) {
      try {
        const data = await dataRes.json();
        liveFlows = data && data.flows ? data.flows.filter(f => f.status === "live").map(f => f.id) : [];
        allSegmentIds = data && data.allSegments ? data.allSegments.map(s => s.id) : [];
      } catch (_) {}
    }
    const featuredIds = acct === "us" ? FEATURED_SEGMENT_IDS_US : [];
    const segChunkSize = Math.max(1, Math.ceil(allSegmentIds.length / 4));
    const segChunkStart = (dayBucket % 4) * segChunkSize;
    const segChunk = allSegmentIds.slice(segChunkStart, segChunkStart + segChunkSize);
    const flowChunkSize = Math.max(1, Math.ceil(liveFlows.length / 2));
    const flowChunkStart = (dayBucket % 2) * flowChunkSize;
    const flowChunk = liveFlows.slice(flowChunkStart, flowChunkStart + flowChunkSize);
    const targets = [
      ...featuredIds.map(id => baseUrl + "/api/segment-count?id=" + id + "&account=" + acct),
      ...segChunk.map(id => baseUrl + "/api/segment-count?id=" + id + "&account=" + acct),
      ...flowChunk.map(id => baseUrl + "/api/flow-perf?id=" + id + "&days=7&account=" + acct)
    ];
    targets.forEach(url => { fetch(url).catch(() => null); });
    return { acct, target: targets.length, flowChunk: flowChunk.length, segChunk: segChunk.length };
  }

  const us = await warmAccount("us");
  const br = process.env.KLAVIYO_API_KEY_BR ? await warmAccount("br") : null;

  return new Response(JSON.stringify({
    triggeredAt: new Date().toISOString(),
    dayBucket, us, br
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
