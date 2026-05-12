// Vercel Edge Function — atribuição Klaviyo via Shopify (last-click UTM).
// Endpoint: /api/shopify-attribution?account=us|br&month=YYYY-MM
// Estratégia: fetch todos os orders do mês, filtra utm_source=klaviyo no landing_site.
// Cache 7d. Cron warm os 3 últimos meses diariamente.

export const config = { runtime: "edge" };

const API_VERSION = "2025-01";
const MAX_PAGES = 30; // 30 × 250 = 7.500 pedidos/mês (cobre conta US com folga)

function getCreds(account) {
  if (account === "br") return {
    token: process.env.SHOPIFY_BR_ADMIN_API_TOKEN,
    domain: process.env.SHOPIFY_BR_STORE_DOMAIN
  };
  return {
    token: process.env.SHOPIFY_US_ADMIN_API_TOKEN,
    domain: process.env.SHOPIFY_US_STORE_DOMAIN
  };
}

function isKlaviyoAttributed(order) {
  const ls = order.landing_site || "";
  // Default Klaviyo email tracking: utm_source=klaviyo (canonical)
  return /[?&]utm_source=klaviyo\b/i.test(ls);
}

function monthBounds(year, month) {
  // month 1-12 (humano), retorna ISO strings UTC
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

async function fetchAllOrdersForMonth(domain, token, year, month) {
  const { startISO, endISO } = monthBounds(year, month);
  const base = "https://" + domain + "/admin/api/" + API_VERSION + "/orders.json";
  let nextUrl = base + "?status=any&limit=250&created_at_min=" + encodeURIComponent(startISO) + "&created_at_max=" + encodeURIComponent(endISO) + "&fields=id,total_price,landing_site,currency,created_at";

  const orders = [];
  let pages = 0;
  while (nextUrl && pages < MAX_PAGES) {
    const res = await fetch(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": token,
        "accept": "application/json"
      }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error("Shopify " + res.status + " on page " + (pages + 1) + ": " + text.slice(0, 150));
    }
    const data = await res.json();
    for (const o of (data.orders || [])) orders.push(o);

    // Shopify pagination via Link header (cursor-based via page_info)
    const link = res.headers.get("Link") || res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>\s*;\s*rel="next"/i);
    nextUrl = m ? m[1] : null;
    pages++;
  }
  return { orders, pages, hitMaxPages: pages >= MAX_PAGES && nextUrl };
}

function aggregate(orders) {
  let totalOrders = 0, klaviyoOrders = 0;
  let totalRevenue = 0, klaviyoRevenue = 0;
  let currency = null;
  for (const o of orders) {
    const price = parseFloat(o.total_price || "0");
    if (!isFinite(price) || price < 0) continue;
    totalOrders++;
    totalRevenue += price;
    if (!currency && o.currency) currency = o.currency;
    if (isKlaviyoAttributed(o)) {
      klaviyoOrders++;
      klaviyoRevenue += price;
    }
  }
  return { totalOrders, totalRevenue, klaviyoOrders, klaviyoRevenue, currency };
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const account = (url.searchParams.get("account") || "us").toLowerCase();
    const monthStr = url.searchParams.get("month") || "";

    if (!["us", "br"].includes(account)) {
      return new Response(JSON.stringify({ error: "account inválida" }), { status: 400, headers: { "content-type": "application/json" } });
    }

    const { token, domain } = getCreds(account);
    if (!token || !domain) {
      return new Response(JSON.stringify({ error: "SHOPIFY env vars não configuradas para account=" + account }), { status: 500, headers: { "content-type": "application/json" } });
    }

    let year, month;
    if (/^\d{4}-\d{2}$/.test(monthStr)) {
      const parts = monthStr.split("-").map(Number);
      year = parts[0];
      month = parts[1];
    } else {
      const now = new Date();
      year = now.getUTCFullYear();
      month = now.getUTCMonth() + 1;
    }

    const { orders, pages, hitMaxPages } = await fetchAllOrdersForMonth(domain, token, year, month);
    const agg = aggregate(orders);
    const attributionPct = agg.totalRevenue > 0 ? agg.klaviyoRevenue / agg.totalRevenue : 0;

    return new Response(JSON.stringify({
      account, year, month,
      monthKey: year + "-" + String(month).padStart(2, "0"),
      totalOrders: agg.totalOrders,
      totalRevenue: Number(agg.totalRevenue.toFixed(2)),
      klaviyoOrders: agg.klaviyoOrders,
      klaviyoRevenue: Number(agg.klaviyoRevenue.toFixed(2)),
      attributionPct: Number((attributionPct * 100).toFixed(2)),
      currency: agg.currency,
      pages,
      hitMaxPages: !!hitMaxPages,
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": agg.totalOrders > 0 ? "public, s-maxage=604800, stale-while-revalidate=86400" : "public, s-maxage=600"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60" }
    });
  }
}
