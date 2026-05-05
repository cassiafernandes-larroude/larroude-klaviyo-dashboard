// Vercel Edge Function — busca dados do Klaviyo e retorna JSON consolidado.
// Inclui LTV windows: 12M, 6M, 3M (revenue/orders/uniques) — frontend calcula forecast 3M.
// NÃO inclui mais profile_count dos segmentos featured — esses são buscados
// individualmente pelo frontend via /api/segment-count?id=XXX.
// Cache de 24h via Cache-Control.
//
// Env var necessária: KLAVIYO_API_KEY

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";
const PLACED_ORDER_METRIC_ID = "RWb2qv";

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

async function fetchPlacedOrderWindow(days) {
  // Aggregates Placed Order over last N days. Returns { revenue, orders, uniqueBuyerMonths, days }
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
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
    const revenue = sum(m.sum_value);
    const orders = sum(m.count);
    const uniqueBuyerMonths = sum(m.unique);
    return {
      days,
      revenue,
      orders,
      uniqueBuyerMonths,
      aov: orders > 0 ? revenue / orders : 0,
      ltv: uniqueBuyerMonths > 0 ? revenue / uniqueBuyerMonths : 0,
      monthlyRevenue: m.sum_value || [],
      monthlyOrders: m.count || [],
      monthlyUniques: m.unique || []
    };
  } catch (e) {
    console.warn("metric_aggregate failed for " + days + "d:", e.message);
    return null;
  }
}

export default async function handler(req) {
  try {
    // Múltiplas janelas de revenue + base info em paralelo
    const [account, flows, allSegments, rev3M, rev6M, rev12M] = await Promise.all([
      fetchAccount(),
      fetchAllFlows(),
      fetchAllSegments(),
      fetchPlacedOrderWindow(90),
      fetchPlacedOrderWindow(180),
      fetchPlacedOrderWindow(365)
    ]);

    // Forecast 3M = média mensal trailing 12M × 3
    let forecast3M = null;
    if (rev12M && rev12M.uniqueBuyerMonths > 0) {
      const avgMonthlyRevenue = rev12M.revenue / 12;
      const avgMonthlyUniques = rev12M.uniqueBuyerMonths / 12;
      const projectedRevenue = avgMonthlyRevenue * 3;
      const projectedUniques = avgMonthlyUniques * 3;
      forecast3M = {
        days: 90,
        revenue: projectedRevenue,
        uniqueBuyerMonths: projectedUniques,
        ltv: projectedUniques > 0 ? projectedRevenue / projectedUniques : 0,
        method: "trailing_12m_average × 3"
      };
    }

    const data = {
      fetchedAt: new Date().toISOString(),
      account,
      flows,
      allSegments,
      featuredSegments: FEATURED_SEGMENTS,
      revenue: rev3M, // backward compat: revenue = 3 meses
      ltvWindows: {
        l3m: rev3M,
        l6m: rev6M,
        l12m: rev12M,
        forecast3m: forecast3M
      }
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
      headers: { "content-type": "application/json" }
    });
  }
}
