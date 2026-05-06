// Vercel Edge Function — performance de TODOS flows live em 1 batch só.
// Endpoint: /api/performance?account=us|br&days=7|14|28
// Estratégia: usa Klaviyo `contains-any(flow_id, [...])` para puxar TODOS flows
// em 2 chamadas (current + previous period). Cache 7 dias.

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 4000;

// Metric IDs conhecidos (Placed Order) — pula chamada /metrics
const KNOWN_METRIC_IDS = { us: "RWb2qv", br: "RG3FHD" };

function getApiKey(account) {
  if (account === "br") return process.env.KLAVIYO_API_KEY_BR;
  return process.env.KLAVIYO_API_KEY_US || process.env.KLAVIYO_API_KEY;
}

async function klaviyoFetchWithRetry(apiKey, path, opts = {}) {
  let lastRes = null;
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
      const text = await res.text();
      throw new Error("Klaviyo " + res.status + ": " + text.slice(0, 200));
    }
    const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
    const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_WAIT_MS) : Math.min(1000 * Math.pow(2, attempt - 1), MAX_WAIT_MS);
    lastRes = res;
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, waitMs));
  }
  if (lastRes) {
    const text = await lastRes.text();
    throw new Error("Klaviyo 429 after retries: " + text.slice(0, 200));
  }
  throw new Error("Klaviyo unreachable");
}

async function findPlacedOrderMetricId(apiKey) {
  try {
    const fetchPromise = klaviyoFetchWithRetry(apiKey, "/metrics?fields[metric]=name");
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000));
    const j = await Promise.race([fetchPromise, timeoutPromise]);
    const placed = (j.data || []).find(m => m.attributes && m.attributes.name === "Placed Order");
    return placed ? placed.id : null;
  } catch (_) { return null; }
}

async function fetchLiveFlows(apiKey) {
  const all = [];
  let url = "/flows?fields[flow]=name,status&filter=and(equals(archived,false),equals(status,%22live%22))&page[size]=50";
  let safety = 5;
  while (url && safety-- > 0) {
    const j = await klaviyoFetchWithRetry(apiKey, url.replace(KLAVIYO_BASE, ""));
    (j.data || []).forEach(f => all.push({ id: f.id, name: f.attributes && f.attributes.name }));
    url = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
  }
  return all;
}

function periodRange(days, offset) {
  const end = new Date(Date.now() - offset * 86400000);
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = d => d.toISOString().slice(0, 19) + "Z";
  return { start: fmt(start), end: fmt(end) };
}

async function fetchAllFlowsReport(apiKey, metricId, timeframe, flowIds) {
  if (flowIds.length === 0) return {};
  const body = {
    data: {
      type: "flow-values-report",
      attributes: {
        statistics: ["recipients", "delivered", "opens_unique", "clicks_unique", "conversion_uniques", "open_rate", "click_rate", "conversion_rate", "conversion_value"],
        timeframe: { start: timeframe.start, end: timeframe.end },
        conversion_metric_id: metricId,
        filter: "and(equals(send_channel,\"email\"),contains-any(flow_id," + JSON.stringify(flowIds) + "))"
      }
    }
  };
  const j = await klaviyoFetchWithRetry(apiKey, "/flow-values-reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const map = {};
  const results = j && j.data && j.data.attributes && j.data.attributes.results || [];
  results.forEach(r => {
    const id = r.groupings && r.groupings.flow_id;
    if (!id) return;
    const s = r.statistics || {};
    map[id] = {
      flow_id: id,
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

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const daysStr = url.searchParams.get("days") || "7";
    const days = parseInt(daysStr, 10);
    const account = (url.searchParams.get("account") || "us").toLowerCase();

    if (![7, 14, 28].includes(days)) {
      return new Response(JSON.stringify({ error: "days deve ser 7, 14 ou 28" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (account !== "us" && account !== "br") {
      return new Response(JSON.stringify({ error: "account inválida" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const apiKey = getApiKey(account);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY_" + account.toUpperCase() + " não configurada" }), { status: 500, headers: { "content-type": "application/json" } });
    }

    // 1. Metric ID conhecido + flows live em paralelo (pula /metrics, economiza 5–8s)
    const metricId = KNOWN_METRIC_IDS[account] || await findPlacedOrderMetricId(apiKey);
    const liveFlows = await fetchLiveFlows(apiKey);

    if (!metricId) {
      return new Response(JSON.stringify({
        fetchedAt: new Date().toISOString(), days, account,
        current: {}, previous: {}, liveFlows,
        error: "Placed Order metric não encontrado"
      }), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=300" } });
    }

    if (liveFlows.length === 0) {
      return new Response(JSON.stringify({
        fetchedAt: new Date().toISOString(), days, account,
        current: {}, previous: {}, liveFlows: []
      }), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=300" } });
    }

    const flowIds = liveFlows.map(f => f.id);
    const cur = periodRange(days, 0);
    const prev = periodRange(days, days);

    // 2. Current + previous em paralelo (Klaviyo aceita duas chamadas simultâneas pra report endpoints)
    const [currentMap, previousMap] = await Promise.all([
      fetchAllFlowsReport(apiKey, metricId, cur, flowIds).catch(e => ({ _error: e.message })),
      fetchAllFlowsReport(apiKey, metricId, prev, flowIds).catch(e => ({ _error: e.message }))
    ]);

    // Anexa name+status em cada current
    const flowsById = Object.fromEntries(liveFlows.map(f => [f.id, f]));
    Object.keys(currentMap).forEach(id => {
      if (id !== "_error" && flowsById[id]) {
        currentMap[id].flow_name = flowsById[id].name;
        currentMap[id].status = "live";
      }
    });
    Object.keys(previousMap).forEach(id => {
      if (id !== "_error" && flowsById[id]) {
        previousMap[id].flow_name = flowsById[id].name;
      }
    });

    return new Response(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      days, account,
      currentPeriod: cur, previousPeriod: prev,
      current: currentMap, previous: previousMap,
      liveFlowCount: liveFlows.length,
      currentError: currentMap._error || null,
      previousError: previousMap._error || null
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": (currentMap._error || previousMap._error) ? "public, s-maxage=300" : "public, s-maxage=604800, stale-while-revalidate=86400"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
}
