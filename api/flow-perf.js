// Vercel Edge Function — busca performance de UM flow específico para current + previous period.
// Endpoint: /api/flow-perf?id=FLOW_ID&days=7|14|28
// Cada chamada tem seu próprio orçamento de 25s, com retry em 429.
// Cache de 24h por (flow, days).

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";
const PLACED_ORDER_METRIC_ID = "RWb2qv";
const MAX_ATTEMPTS = 6;

async function klaviyoFetchWithRetry(path, opts = {}) {
  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) throw new Error("KLAVIYO_API_KEY env var não configurada");
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
      const text = await res.text();
      throw new Error("Klaviyo " + res.status + ": " + text.slice(0, 200));
    }
    const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
    const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : Math.min(1000 * Math.pow(2, attempt - 1), 8000);
    last = res;
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, waitMs));
  }
  if (last) {
    const text = await last.text();
    throw new Error("Klaviyo 429 after retries: " + text.slice(0, 200));
  }
  throw new Error("unreachable");
}

function periodRange(days, offset) {
  const end = new Date(Date.now() - offset * 86400000);
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = d => d.toISOString().slice(0, 19) + "Z";
  return { start: fmt(start), end: fmt(end) };
}

async function fetchFlowReport(timeframe, flowId) {
  const body = {
    data: {
      type: "flow-values-report",
      attributes: {
        statistics: ["recipients", "delivered", "opens_unique", "clicks_unique", "conversion_uniques", "open_rate", "click_rate", "conversion_rate", "conversion_value"],
        timeframe: { start: timeframe.start, end: timeframe.end },
        conversion_metric_id: PLACED_ORDER_METRIC_ID,
        filter: "and(equals(send_channel,\"email\"),equals(flow_id,\"" + flowId + "\"))"
      }
    }
  };
  const j = await klaviyoFetchWithRetry("/flow-values-reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const results = j && j.data && j.data.attributes && j.data.attributes.results || [];
  if (results.length === 0) return null;
  const s = results[0].statistics || {};
  return {
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
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const days = parseInt(url.searchParams.get("days") || "28", 10);

  if (!id || !/^[A-Za-z0-9]+$/.test(id)) {
    return new Response(JSON.stringify({ error: "missing or invalid id" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (![7, 14, 28].includes(days)) {
    return new Response(JSON.stringify({ error: "days must be 7, 14, or 28" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  try {
    const cur = periodRange(days, 0);
    const prev = periodRange(days, days);

    const [current, previous] = await Promise.all([
      fetchFlowReport(cur, id),
      fetchFlowReport(prev, id)
    ]);

    return new Response(JSON.stringify({
      flow_id: id,
      days,
      currentPeriod: cur,
      previousPeriod: prev,
      current,
      previous,
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": (current || previous) ? "public, s-maxage=86400, stale-while-revalidate=3600" : "public, s-maxage=300"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      flow_id: id,
      days,
      current: null,
      previous: null,
      error: e.message || String(e),
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=60"
      }
    });
  }
}
