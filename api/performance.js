// Vercel Edge Function — busca performance dos flows para um período (7/14/28d).
// Endpoint: /api/performance?days=28
// Retorna current period + previous period agregados por flow_id.

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";
const PLACED_ORDER_METRIC_ID = "RWb2qv";

async function klaviyoFetch(path, opts = {}) {
  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) throw new Error("KLAVIYO_API_KEY env var não configurada");
  const res = await fetch(KLAVIYO_BASE + path, {
    ...opts,
    headers: {
      "Authorization": "Klaviyo-API-Key " + apiKey,
      "accept": "application/json",
      "revision": REVISION,
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Klaviyo " + res.status + ": " + text.slice(0, 300));
  }
  return await res.json();
}

function periodRange(days, offset) {
  const end = new Date(Date.now() - offset * 86400000);
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = d => d.toISOString().slice(0, 19) + "Z";
  return { start: fmt(start), end: fmt(end) };
}

async function fetchLiveFlows() {
  const all = [];
  let url = "/flows?fields[flow]=name,status&filter=and(equals(archived,false),equals(status,%22live%22))&page[size]=50";
  let safety = 5;
  while (url && safety-- > 0) {
    const j = await klaviyoFetch(url.replace(KLAVIYO_BASE, ""));
    (j.data || []).forEach(f => all.push({ id: f.id, name: f.attributes && f.attributes.name }));
    url = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
  }
  return all;
}

async function fetchFlowReportBatch(timeframe, flowIds) {
  // Klaviyo flow-values-reports: timeframe expects { start, end } ISO format
  const body = {
    data: {
      type: "flow-values-report",
      attributes: {
        statistics: ["recipients", "delivered", "opens_unique", "clicks_unique", "conversion_uniques", "open_rate", "click_rate", "conversion_rate", "conversion_value"],
        timeframe: { start: timeframe.start, end: timeframe.end },
        conversion_metric_id: PLACED_ORDER_METRIC_ID,
        filter: "and(equals(send_channel,\"email\"),contains-any(flow_id," + JSON.stringify(flowIds) + "))"
      }
    }
  };
  return await klaviyoFetch("/flow-values-reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function aggregate(payload, flowsById) {
  // Klaviyo retorna data.attributes.results (não flow_aggregation!)
  const map = {};
  const results = payload && payload.data && payload.data.attributes && payload.data.attributes.results || [];
  results.forEach(r => {
    const groupings = r.groupings || {};
    const id = groupings.flow_id;
    if (!id) return;
    const s = r.statistics || {};
    map[id] = {
      flow_id: id,
      flow_name: (flowsById[id] && flowsById[id].name) || id,
      recipients: s.recipients || 0,
      delivered: s.delivered || 0,
      opens: s.opens_unique || 0,
      clicks: s.clicks_unique || 0,
      conversions: s.conversion_uniques || 0,
      revenue: s.conversion_value || 0,
      openRate: s.open_rate || 0,
      clickRate: s.click_rate || 0,
      conversionRate: s.conversion_rate || 0
    };
  });
  return map;
}

async function fetchFlowReportFull(timeframe, liveFlows) {
  const BATCH_SIZE = 8;
  const flowsById = Object.fromEntries(liveFlows.map(f => [f.id, f]));
  const liveIds = liveFlows.map(f => f.id);
  const all = {};
  const errors = [];
  for (let i = 0; i < liveIds.length; i += BATCH_SIZE) {
    const batch = liveIds.slice(i, i + BATCH_SIZE);
    try {
      const payload = await fetchFlowReportBatch(timeframe, batch);
      const agg = aggregate(payload, flowsById);
      Object.assign(all, agg);
    } catch (e) {
      errors.push({ batch: i, error: e.message.slice(0, 200) });
    }
  }
  return { all, errors };
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const daysStr = url.searchParams.get("days") || "28";
    const days = parseInt(daysStr, 10);
    if (![7, 14, 28].includes(days)) {
      return new Response(JSON.stringify({ error: "days deve ser 7, 14 ou 28" }), { status: 400, headers: { "content-type": "application/json" } });
    }

    const liveFlows = await fetchLiveFlows();
    const cur = periodRange(days, 0);
    const prev = periodRange(days, days);

    const [curRes, prevRes] = await Promise.all([
      fetchFlowReportFull(cur, liveFlows),
      fetchFlowReportFull(prev, liveFlows)
    ]);

    return new Response(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      days,
      currentPeriod: cur,
      previousPeriod: prev,
      current: curRes.all,
      previous: prevRes.all,
      currentErrors: curRes.errors,
      previousErrors: prevRes.errors,
      liveFlowCount: liveFlows.length
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=86400, stale-while-revalidate=3600"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}
