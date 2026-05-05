// Vercel Edge Function — busca dados do Klaviyo e retorna JSON consolidado.
// Cache de 24h via Cache-Control. Primeiro request do dia paga ~30s; os outros são instantâneos.
//
// Env var necessária: KLAVIYO_API_KEY (Private API Key com escopos read em flows, segments, metrics, accounts, events)

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";
const PLACED_ORDER_METRIC_ID = "RWb2qv"; // Placed Order — confirme no seu Klaviyo

// Segmentos featured (com descrição manual)
const FEATURED_SEGMENTS = [
  { id: "XF8f94", name: "ENGAGED L30D", health: "good", desc: "Abriu/clicou/comprou nos últimos 30 dias · com consentimento de email." },
  { id: "VzX6n5", name: "ENGAGED L60D", health: "good", desc: "Engajou em qualquer canal nos últimos 60 dias · audiência principal de campanhas." },
  { id: "TKgWFC", name: "ENGAGED L90D", health: "good", desc: "Cobertura mais larga — últimos 90 dias." },
  { id: "VDLdYZ", name: "Lapsed Customers (em risco)", health: "warning", desc: "RFM 'at risk' ou 'needs attention'. Janela ideal de winback." },
  { id: "QQPern", name: "[EXCLUDE] Unengaged", health: "alert", desc: "Sem ação em 365D + 20+ recebimentos sem abrir. Excluído de envios." },
  { id: "TDXDzA", name: "Repeat Buyers", health: "good", desc: "2+ compras alltime · com consentimento." },
  { id: "WGrCjj", name: "VIP Customers", health: "good", desc: "5+ compras alltime — tier máximo." },
  { id: "RaXvQd", name: "High LTV (preditivo)", health: "good", desc: "Klaviyo predictive: total CLV > $400, AOV > $350, predicted_orders > 2." },
  { id: "Sudqwh", name: "Collect customers", health: "good", desc: "Compradores de coleções específicas (Colléct, Best Sellers, Accessories, etc)." }
];

const KEY_SEGMENT_IDS = FEATURED_SEGMENTS.map(s => s.id);

async function klaviyoFetch(path, opts = {}) {
  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) throw new Error("KLAVIYO_API_KEY env var não configurada na Vercel");
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
    throw new Error("Klaviyo " + res.status + " on " + path + ": " + text.slice(0, 200));
  }
  return await res.json();
}

async function fetchAccount() {
  const j = await klaviyoFetch("/accounts");
  const acc = j.data && j.data[0];
  if (!acc) return null;
  const a = acc.attributes || {};
  return {
    id: acc.id,
    organization: a.contactInformation && a.contactInformation.organizationName,
    senderEmail: a.contactInformation && a.contactInformation.defaultSenderEmail,
    currency: a.preferredCurrency,
    timezone: a.timezone,
    locale: a.locale,
    industry: a.industry
  };
}

async function fetchAllFlows() {
  const all = [];
  let url = "/flows?fields[flow]=name,status,trigger_type,archived,created,updated&filter=equals(archived,false)&page[size]=50";
  let safety = 8;
  while (url && safety-- > 0) {
    const j = await klaviyoFetch(url.replace(KLAVIYO_BASE, ""));
    (j.data || []).forEach(f => {
      const a = f.attributes || {};
      all.push({
        id: f.id, name: a.name, status: a.status, triggerType: a.trigger_type,
        created: a.created, updated: a.updated
      });
    });
    url = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
  }
  return all;
}

async function fetchAllSegments() {
  const all = [];
  let url = "/segments?fields[segment]=name,created,updated,is_active,is_starred&filter=equals(is_active,true)&sort=-updated";
  let safety = 12;
  while (url && safety-- > 0) {
    const j = await klaviyoFetch(url.replace(KLAVIYO_BASE, ""));
    (j.data || []).forEach(s => {
      const a = s.attributes || {};
      all.push({
        id: s.id, name: a.name, updated: a.updated, created: a.created,
        starred: !!a.is_starred
      });
    });
    url = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
  }
  return all;
}

async function fetchSegmentCount(segmentId) {
  try {
    const j = await klaviyoFetch("/segments/" + encodeURIComponent(segmentId) + "?additional-fields[segment]=profile_count");
    return j.data && j.data.attributes && typeof j.data.attributes.profile_count === "number"
      ? j.data.attributes.profile_count : null;
  } catch (e) {
    console.warn("segment fetch failed", segmentId, e.message);
    return null;
  }
}

async function fetchKeySegmentCounts() {
  // Paralelo no server-side é seguro — sem bug de race do MCP, e cabe no timeout 25s da Edge Hobby
  const entries = await Promise.all(KEY_SEGMENT_IDS.map(id =>
    fetchSegmentCount(id).then(c => [id, c])
  ));
  return Object.fromEntries(entries);
}

async function fetchPlacedOrderL3M() {
  // Últimos 3 meses
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86400000);
  const fmt = d => d.toISOString().slice(0, 19);
  const body = {
    data: {
      type: "metric-aggregate",
      attributes: {
        metric_id: PLACED_ORDER_METRIC_ID,
        measurements: ["count", "sum_value", "unique"],
        interval: "month",
        page_size: 500,
        timezone: "US/Eastern",
        filter: ["greater-or-equal(datetime," + start.toISOString().slice(0,19) + "),less-than(datetime," + end.toISOString().slice(0,19) + ")"]
      }
    }
  };
  try {
    const j = await klaviyoFetch("/metric-aggregates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const m = j.data && j.data.attributes && j.data.attributes.data && j.data.attributes.data[0] && j.data.attributes.data[0].measurements;
    if (!m) return null;
    const sum = arr => (arr || []).reduce((a, b) => a + (b || 0), 0);
    const totalRevenue = sum(m.sum_value);
    const totalOrders = sum(m.count);
    return {
      revenue: totalRevenue,
      orders: totalOrders,
      aov: totalOrders > 0 ? totalRevenue / totalOrders : 0,
      uniqueBuyerMonths: sum(m.unique)
    };
  } catch (e) {
    console.warn("metric_aggregate failed:", e.message);
    return null;
  }
}

export default async function handler(req) {
  try {
    // Tudo em paralelo (server side, sem MCP race condition)
    const [account, flows, allSegments, keyCounts, revenue] = await Promise.all([
      fetchAccount(),
      fetchAllFlows(),
      fetchAllSegments(),
      fetchKeySegmentCounts(),
      fetchPlacedOrderL3M()
    ]);

    const data = {
      fetchedAt: new Date().toISOString(),
      account,
      flows,
      allSegments,
      keySegmentCounts: keyCounts,
      featuredSegments: FEATURED_SEGMENTS,
      revenue
    };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=86400, stale-while-revalidate=3600"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
    