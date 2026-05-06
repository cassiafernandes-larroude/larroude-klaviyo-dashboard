// Vercel Edge Function — busca dados do Klaviyo (US ou BR) e retorna JSON consolidado.
// Suporta ?account=us|br via query string. Cache separado por account.

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";

const FEATURED_SEGMENTS_BY_ACCOUNT = {
  us: [
    { id: "XF8f94", name: "ENGAGED L30D", health: "good", desc: "Abriu/clicou/comprou nos últimos 30 dias · com consentimento de email." },
    { id: "VzX6n5", name: "ENGAGED L60D", health: "good", desc: "Engajou em qualquer canal nos últimos 60 dias · audiência principal de campanhas." },
    { id: "TKgWFC", name: "ENGAGED L90D", health: "good", desc: "Cobertura mais larga — últimos 90 dias." },
    { id: "VDLdYZ", name: "Lapsed Customers (em risco)", health: "warning", desc: "RFM 'at risk' ou 'needs attention'. Janela ideal de winback." },
    { id: "QQPern", name: "[EXCLUDE] Unengaged", health: "alert", desc: "Sem ação em 365D + 20+ recebimentos sem abrir. Excluído de envios." },
    { id: "TDXDzA", name: "Repeat Buyers", health: "good", desc: "2+ compras alltime · com consentimento." },
    { id: "WGrCjj", name: "VIP Customers", health: "good", desc: "5+ compras alltime — tier máximo." },
    { id: "RaXvQd", name: "High LTV (preditivo)", health: "good", desc: "Klaviyo predictive: total CLV > $400, AOV > $350, predicted_orders > 2." },
    { id: "Sudqwh", name: "Collect customers", health: "good", desc: "Compradores de coleções específicas (Colléct, Best Sellers, Accessories, etc)." }
  ],
  br: [
    { id: "V7SkpA", name: "ENGAGED L30D", health: "good", desc: "Abriu OU clicou +3 EMM nos últimos 30D · com Optin EMM = True. Audiência principal de campanhas." },
    { id: "RxfYKt", name: "ENGAGED L120D", health: "good", desc: "Cobertura larga — engajou nos últimos 120 dias." },
    { id: "SgCgbU", name: "Lapsed Customers (em risco)", health: "warning", desc: "RFM 'at risk' ou 'needs attention'. Janela ideal de winback." },
    { id: "XcbwM2", name: "KL - Inactive", health: "alert", desc: "Inativos sem engajamento — candidatos a sunset/exclusão de envios." },
    { id: "Ta4EnS", name: "Repeat Buyers", health: "good", desc: "Qualified Repeat: 1 order L120d ou 2 orders L365d ou 3 orders alltime." },
    { id: "RFyTVT", name: "VIP Purchasers", health: "good", desc: "BCO - VIP: 2+ Orders ou High LTV. Tier máximo de compradores BR." }
  ]
};

function getApiKey(account) {
  if (account === "br") return process.env.KLAVIYO_API_KEY_BR;
  return process.env.KLAVIYO_API_KEY_US || process.env.KLAVIYO_API_KEY;
}

async function klaviyoFetch(apiKey, path, opts = {}) {
  if (!apiKey) throw new Error("API key não configurada — verifique KLAVIYO_API_KEY_US/BR");
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

async function fetchAccount(apiKey) {
  const j = await klaviyoFetch(apiKey, "/accounts");
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

async function fetchAllFlows(apiKey) {
  const all = [];
  let url = "/flows?fields[flow]=name,status,trigger_type,archived,created,updated&filter=equals(archived,false)&page[size]=50";
  let safety = 8;
  while (url && safety-- > 0) {
    const j = await klaviyoFetch(apiKey, url.replace(KLAVIYO_BASE, ""));
    (j.data || []).forEach(f => {
      const a = f.attributes || {};
      all.push({ id: f.id, name: a.name, status: a.status, triggerType: a.trigger_type, created: a.created, updated: a.updated });
    });
    url = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
  }
  return all;
}

async function fetchAllSegments(apiKey) {
  const all = [];
  let url = "/segments?fields[segment]=name,created,updated,is_active,is_starred&filter=equals(is_active,true)&sort=-updated";
  let safety = 12;
  while (url && safety-- > 0) {
    const j = await klaviyoFetch(apiKey, url.replace(KLAVIYO_BASE, ""));
    (j.data || []).forEach(s => {
      const a = s.attributes || {};
      all.push({ id: s.id, name: a.name, updated: a.updated, created: a.created, starred: !!a.is_starred });
    });
    url = j.links && j.links.next ? j.links.next.replace(KLAVIYO_BASE, "") : null;
  }
  return all;
}

async function findPlacedOrderMetricId(apiKey) {
  // Descobre o metric_id de "Placed Order" buscando primeira página de métricas (default 50).
  // Placed Order é métrica padrão Shopify, sempre está nos primeiros resultados.
  // Wrap com timeout de 8s pra não bloquear /api/data se Klaviyo estiver lento.
  try {
    const fetchPromise = klaviyoFetch(apiKey, "/metrics?fields[metric]=name");
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
    const j = await Promise.race([fetchPromise, timeoutPromise]);
    const placed = (j.data || []).find(m => m.attributes && m.attributes.name === "Placed Order");
    return placed ? placed.id : null;
  } catch (_) { return null; }
}

async function fetchPlacedOrder12M(apiKey, metricId) {
  if (!metricId) return null;
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86400000);
  const body = {
    data: {
      type: "metric-aggregate",
      attributes: {
        metric_id: metricId,
        measurements: ["count", "sum_value", "unique"],
        interval: "month",
        page_size: 500,
        timezone: "US/Eastern",
        filter: ["greater-or-equal(datetime," + start.toISOString().slice(0,19) + "),less-than(datetime," + end.toISOString().slice(0,19) + ")"]
      }
    }
  };
  try {
    const j = await klaviyoFetch(apiKey, "/metric-aggregates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const m = j.data && j.data.attributes && j.data.attributes.data && j.data.attributes.data[0] && j.data.attributes.data[0].measurements;
    if (!m) return null;
    return { revenue: m.sum_value || [], orders: m.count || [], uniques: m.unique || [] };
  } catch (e) {
    return null;
  }
}

function aggregateWindow(monthly, monthsBack, days) {
  const sliceFrom = m => (m || []).slice(-monthsBack);
  const sum = arr => arr.reduce((a, b) => a + (b || 0), 0);
  const revenue = sum(sliceFrom(monthly.revenue));
  const orders = sum(sliceFrom(monthly.orders));
  const uniques = sum(sliceFrom(monthly.uniques));
  return {
    days, revenue, orders,
    uniqueBuyerMonths: uniques,
    aov: orders > 0 ? revenue / orders : 0,
    ltv: uniques > 0 ? revenue / uniques : 0,
    monthlyRevenue: sliceFrom(monthly.revenue),
    monthlyOrders: sliceFrom(monthly.orders),
    monthlyUniques: sliceFrom(monthly.uniques)
  };
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const account = (url.searchParams.get("account") || "us").toLowerCase();
    if (account !== "us" && account !== "br") {
      return new Response(JSON.stringify({ error: "account deve ser 'us' ou 'br'" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const apiKey = getApiKey(account);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API key da conta " + account.toUpperCase() + " não configurada na Vercel" }), { status: 500, headers: { "content-type": "application/json" } });
    }

    // Descobre Placed Order metric dinamicamente
    const metricIdPromise = findPlacedOrderMetricId(apiKey);
    const [account_, flows, allSegments, metricId] = await Promise.all([
      fetchAccount(apiKey),
      fetchAllFlows(apiKey),
      fetchAllSegments(apiKey),
      metricIdPromise
    ]);

    let monthly = null;
    if (metricId) {
      monthly = await fetchPlacedOrder12M(apiKey, metricId);
    }

    let l3m = null, l6m = null, l12m = null, forecast3M = null;
    if (monthly) {
      l3m = aggregateWindow(monthly, 3, 90);
      l6m = aggregateWindow(monthly, 6, 180);
      l12m = aggregateWindow(monthly, 12, 365);
      if (l12m.uniqueBuyerMonths > 0) {
        const avgRev = l12m.revenue / 12;
        const avgUni = l12m.uniqueBuyerMonths / 12;
        forecast3M = {
          days: 90, revenue: avgRev * 3, uniqueBuyerMonths: avgUni * 3,
          ltv: avgUni > 0 ? avgRev / avgUni : 0,
          method: "trailing_12m_average × 3"
        };
      }
    }

    const data = {
      fetchedAt: new Date().toISOString(),
      account: account_,
      accountKey: account,
      flows,
      allSegments,
      featuredSegments: FEATURED_SEGMENTS_BY_ACCOUNT[account] || [],
      placedOrderMetricId: metricId,
      revenue: l3m,
      ltvWindows: { l3m, l6m, l12m, forecast3m: forecast3M }
    };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=604800, stale-while-revalidate=86400"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}
