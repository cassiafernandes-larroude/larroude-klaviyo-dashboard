// Vercel Edge Function — receita por audiência de campanha (Klaviyo /campaign-values-reports).
// Endpoint: /api/campaign-revenue?account=us|br&days=7|14|28|60
// Retorna: receita + conversões por segmento (somando todas campanhas que usaram aquele segmento como audiência).

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2025-04-15";
const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 3500;
const KNOWN_METRIC_IDS = { us: "RWb2qv", br: "RG3FHD" };

function getApiKey(account) {
  if (account === "br") return process.env.KLAVIYO_API_KEY_BR;
  return process.env.KLAVIYO_API_KEY_US || process.env.KLAVIYO_API_KEY;
}

async function klaviyoFetchWithRetry(apiKey, path, opts = {}) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(KLAVIYO_BASE + path, {
      ...opts,
      headers: {
        "Authorization": "Klaviyo-API-Key " + apiKey,
        "accept": "application/json",
        "revision": REVISION,
        ...(opts.headers || {})
      }
    });
    if (res.ok) return await res.json();
    if (res.status !== 429) {
      const t = await res.text();
      throw new Error("Klaviyo " + res.status + ": " + t.slice(0, 150));
    }
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const wait = ra > 0 ? Math.min(ra * 1000, MAX_WAIT_MS) : Math.min(1000 * Math.pow(2, attempt - 1), MAX_WAIT_MS);
    last = res;
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, wait));
  }
  if (last) {
    const t = await last.text();
    throw new Error("Klaviyo 429 after retries: " + t.slice(0, 150));
  }
  throw new Error("Klaviyo unreachable");
}

function periodRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = d => d.toISOString().slice(0, 19) + "Z";
  return { start: fmt(start), end: fmt(end) };
}

async function fetchSentCampaigns(apiKey, since) {
  // Fetch sent campaigns + their audiences
  const all = [];
  // Klaviyo /campaigns requer filtro com messages.channel (obrigatório), e usa aspas duplas escapadas
  const filter = "and(equals(messages.channel,\"email\"),greater-or-equal(send_time,\"" + since + "\"))";
  let url = "/campaigns?filter=" + encodeURIComponent(filter) + "&fields[campaign]=name,send_time,audiences,status&page[size]=50";
  let safety = 12;
  while (url && safety-- > 0) {
    const j = await klaviyoFetchWithRetry(apiKey, url.replace(KLAVIYO_BASE, ""));
    (j.data || []).forEach(c => {
      const a = c.attributes || {};
      // Filtra status no client (filter inline tem limitações)
      if (a.status && !["Sent", "Sending", "Scheduled"].includes(a.status)) return;
      const audiences = a.audiences || {};
      const included = audiences.included || [];
      all.push({
        id: c.id,
        name: a.name,
        send_time: a.send_time,
        status: a.status,
        audience_ids: included
      });
    });
    url = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
  }
  return all;
}

async function fetchCampaignRevenueBatch(apiKey, metricId, timeframe, campaignIds) {
  if (campaignIds.length === 0) return {};
  const body = {
    data: {
      type: "campaign-values-report",
      attributes: {
        statistics: ["recipients", "delivered", "opens_unique", "clicks_unique", "conversion_uniques", "conversion_value"],
        timeframe: { start: timeframe.start, end: timeframe.end },
        conversion_metric_id: metricId,
        filter: "and(equals(send_channel,\"email\"),contains-any(campaign_id," + JSON.stringify(campaignIds) + "))"
      }
    }
  };
  const j = await klaviyoFetchWithRetry(apiKey, "/campaign-values-reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const map = {};
  const results = j && j.data && j.data.attributes && j.data.attributes.results || [];
  results.forEach(r => {
    const id = r.groupings && r.groupings.campaign_id;
    if (!id) return;
    const s = r.statistics || {};
    map[id] = {
      recipients: s.recipients || 0,
      delivered: s.delivered || 0,
      opens: s.opens_unique || 0,
      clicks: s.clicks_unique || 0,
      conversions: s.conversion_uniques || 0,
      revenue: s.conversion_value || 0
    };
  });
  return map;
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const days = parseInt(url.searchParams.get("days") || "28", 10);
    const account = (url.searchParams.get("account") || "us").toLowerCase();
    if (![7, 14, 28, 60].includes(days)) return new Response(JSON.stringify({ error: "days deve ser 7,14,28,60" }), { status: 400, headers: { "content-type": "application/json" } });
    if (!["us", "br"].includes(account)) return new Response(JSON.stringify({ error: "account inválida" }), { status: 400, headers: { "content-type": "application/json" } });

    const apiKey = getApiKey(account);
    if (!apiKey) return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY não configurada" }), { status: 500, headers: { "content-type": "application/json" } });

    const tf = periodRange(days);
    const metricId = KNOWN_METRIC_IDS[account];

    // 1. Get sent campaigns + their audiences
    const campaigns = await fetchSentCampaigns(apiKey, tf.start);
    if (campaigns.length === 0) {
      return new Response(JSON.stringify({ account, days, timeframe: tf, segments: {}, campaignCount: 0, fetchedAt: new Date().toISOString() }), {
        status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=604800, stale-while-revalidate=86400" }
      });
    }

    // 2. Batch revenue lookup — 80 IDs per batch
    const BATCH = 80;
    const allIds = campaigns.map(c => c.id);
    const revenueMap = {};
    const batches = [];
    for (let i = 0; i < allIds.length; i += BATCH) batches.push(allIds.slice(i, i + BATCH));

    function withTimeout(p, ms, label) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout " + ms)), ms))]); }
    const PER_BATCH_BUDGET = 8000;
    const results = await Promise.all(batches.map((b, idx) =>
      withTimeout(fetchCampaignRevenueBatch(apiKey, metricId, tf, b), PER_BATCH_BUDGET, "batch" + idx).catch(e => ({ _error: e.message }))
    ));
    results.forEach(r => { if (r && !r._error) Object.assign(revenueMap, r); });

    // 3. Aggregate by segment (audience_id)
    const segments = {};
    let totalRevenueAttributed = 0;
    let totalCampaignsWithRevenue = 0;
    campaigns.forEach(c => {
      const rev = revenueMap[c.id];
      if (!rev || !rev.revenue) return;
      totalRevenueAttributed += rev.revenue;
      totalCampaignsWithRevenue++;
      c.audience_ids.forEach(segId => {
        if (!segments[segId]) {
          segments[segId] = { id: segId, revenue: 0, conversions: 0, recipients: 0, campaignCount: 0 };
        }
        segments[segId].revenue += rev.revenue;
        segments[segId].conversions += rev.conversions;
        segments[segId].recipients += rev.recipients;
        segments[segId].campaignCount += 1;
      });
    });

    return new Response(JSON.stringify({
      account, days, timeframe: tf,
      segments,
      campaignCount: campaigns.length,
      campaignsWithRevenue: totalCampaignsWithRevenue,
      totalRevenueAttributed: Number(totalRevenueAttributed.toFixed(2)),
      batchErrors: results.filter(r => r._error).length,
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=604800, stale-while-revalidate=86400"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60" }
    });
  }
}
