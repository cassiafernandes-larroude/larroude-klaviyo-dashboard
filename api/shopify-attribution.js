// Vercel Serverless Function (Node, CommonJS) — atribuição Klaviyo via Shopify
// Lê do BigQuery `larroude-data-platform.shopify_{us,br}.orders` (Airbyte ingested).
// Filtra `landing_site` com `utm_source=klaviyo` (last-click UTM canonical).

const { BigQuery } = require("@google-cloud/bigquery");

let bqClient = null;
function getBQ() {
  if (bqClient) return bqClient;
  const projectId = process.env.GCP_PROJECT_ID || "larroude-data-platform";
  const b64 = process.env.GCP_SA_KEY_BASE64;
  if (!b64) {
    const err = new Error("GCP_SA_KEY_BASE64 não configurado na Vercel.");
    err.code = "NO_CREDENTIALS";
    throw err;
  }
  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new Error("GCP_SA_KEY_BASE64 mal-formado (não é base64 JSON válido)");
  }
  bqClient = new BigQuery({ projectId, credentials });
  return bqClient;
}

module.exports = async function handler(req, res) {
  res.setHeader("content-type", "application/json");
  try {
    const account = ((req.query && req.query.account) || "us").toLowerCase();
    const monthStr = (req.query && req.query.month) || "";

    if (!["us", "br"].includes(account)) {
      res.status(400).end(JSON.stringify({ error: "account inválida (use us|br)" }));
      return;
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

    const pad = n => String(n).padStart(2, "0");
    const startDate = `${year}-${pad(month)}-01`;
    const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
    const endDate = `${nextMonth.y}-${pad(nextMonth.m)}-01`;

    const table = `larroude-data-platform.shopify_${account}.orders`;
    const sql =
      "SELECT" +
      "  COUNT(*) AS total_orders," +
      "  IFNULL(ROUND(SUM(total_price), 2), 0) AS total_revenue," +
      "  COUNTIF(REGEXP_CONTAINS(landing_site, r'(?i)[?&]utm_source=klaviyo')) AS klaviyo_orders," +
      "  IFNULL(ROUND(SUM(IF(REGEXP_CONTAINS(landing_site, r'(?i)[?&]utm_source=klaviyo'), total_price, 0)), 2), 0) AS klaviyo_revenue," +
      "  ANY_VALUE(currency) AS currency " +
      "FROM `" + table + "` " +
      "WHERE created_at >= TIMESTAMP(@start_date) AND created_at < TIMESTAMP(@end_date)";

    const bq = getBQ();
    const [rows] = await bq.query({
      query: sql,
      params: { start_date: startDate, end_date: endDate },
      location: "US"
    });

    const r = rows[0] || {};
    const totalRevenue = Number(r.total_revenue) || 0;
    const klaviyoRevenue = Number(r.klaviyo_revenue) || 0;
    const attributionPct = totalRevenue > 0 ? (klaviyoRevenue / totalRevenue * 100) : 0;

    res.setHeader("cache-control", "public, s-maxage=604800, stale-while-revalidate=86400");
    res.status(200).end(JSON.stringify({
      account,
      year, month,
      monthKey: `${year}-${pad(month)}`,
      totalOrders: Number(r.total_orders) || 0,
      totalRevenue,
      klaviyoOrders: Number(r.klaviyo_orders) || 0,
      klaviyoRevenue,
      attributionPct: Number(attributionPct.toFixed(2)),
      currency: r.currency || (account === "br" ? "BRL" : "USD"),
      source: "bigquery",
      fetchedAt: new Date().toISOString()
    }));
  } catch (e) {
    res.setHeader("cache-control", "public, s-maxage=60");
    res.status(200).end(JSON.stringify({
      error: e.message || String(e),
      code: e.code,
      stack: (e.stack || "").split("\n").slice(0, 3),
      fetchedAt: new Date().toISOString()
    }));
  }
};
