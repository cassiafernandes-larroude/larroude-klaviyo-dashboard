// Vercel Edge Function — LTV (Preditivo + Histórico) via BigQuery
// Endpoint: /api/ltv-windows?account=us|br&days=90|180|365
// Metodologia oficial Larroudé (Triple Whale-like):
//   - LTV Preditivo = AOV × Frequency × (1 / (1 − returning_rate))
//   - LTV Histórico = total_net_sales / total_customers (com refunds, todos os customers)
// Filtros canônicos: exclude cancelled, test, b2b/wholesale, customer 5025734230182.

export const config = { runtime: "edge" };

function base64UrlEncode(input) {
  let str;
  if (typeof input === "string") str = btoa(input);
  else {
    const bytes = new Uint8Array(input);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    str = btoa(bin);
  }
  return str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

let cachedToken = null;
let cachedTokenExp = 0;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExp > now + 60) return cachedToken;
  const b64 = process.env.GCP_SA_KEY_BASE64;
  if (!b64) throw new Error("GCP_SA_KEY_BASE64 não configurado");
  const sa = JSON.parse(atob(b64));
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/bigquery",
    aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now
  }));
  const signingInput = header + "." + payload;
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = signingInput + "." + base64UrlEncode(sigBuf);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + encodeURIComponent(jwt)
  });
  if (!res.ok) throw new Error("OAuth " + res.status + ": " + (await res.text()).slice(0, 200));
  const j = await res.json();
  cachedToken = j.access_token;
  cachedTokenExp = now + (j.expires_in || 3600);
  return cachedToken;
}

async function runBQ(projectId, sql, params) {
  const token = await getAccessToken();
  const body = {
    query: sql,
    useLegacySql: false,
    parameterMode: "NAMED",
    queryParameters: Object.entries(params || {}).map(([name, value]) => ({
      name,
      parameterType: { type: typeof value === "number" ? "INT64" : "STRING" },
      parameterValue: { value: String(value) }
    })),
    location: "US",
    timeoutMs: 15000
  };
  const res = await fetch("https://bigquery.googleapis.com/bigquery/v2/projects/" + encodeURIComponent(projectId) + "/queries", {
    method: "POST", headers: { "Authorization": "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("BQ " + res.status + ": " + (await res.text()).slice(0, 250));
  return await res.json();
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const account = (url.searchParams.get("account") || "us").toLowerCase();
    const days = parseInt(url.searchParams.get("days") || "90", 10);
    if (!["us", "br"].includes(account)) return new Response(JSON.stringify({ error: "account inválida" }), { status: 400, headers: { "content-type": "application/json" } });
    if (![90, 180, 365].includes(days)) return new Response(JSON.stringify({ error: "days deve ser 90, 180 ou 365" }), { status: 400, headers: { "content-type": "application/json" } });

    const table = "larroude-data-platform.shopify_" + account + ".orders";
    const sql = `
      WITH params AS (
        SELECT DATE_SUB(DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY), INTERVAL @days DAY) AS start_date,
               DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AS end_date
      ),
      base AS (
        SELECT
          JSON_VALUE(customer, '$.id') AS customer_id,
          CAST(total_line_items_price AS FLOAT64)
            - CAST(total_discounts AS FLOAT64)
            - IFNULL((
                SELECT SUM(CAST(JSON_VALUE(t, '$.amount') AS FLOAT64))
                FROM UNNEST(JSON_QUERY_ARRAY(refunds)) AS r,
                  UNNEST(JSON_QUERY_ARRAY(r, '$.transactions')) AS t
              ), 0) AS net_sales
        FROM \`${table}\`, params
        WHERE cancelled_at IS NULL AND test = FALSE
          AND JSON_VALUE(customer, '$.id') IS NOT NULL
          AND JSON_VALUE(customer, '$.id') != '5025734230182'
          AND (JSON_VALUE(customer, '$.tags') IS NULL
               OR (NOT REGEXP_CONTAINS(LOWER(JSON_VALUE(customer, '$.tags')), r'b2b')
                   AND NOT REGEXP_CONTAINS(LOWER(JSON_VALUE(customer, '$.tags')), r'wholesale')))
          AND DATE(created_at) BETWEEN params.start_date AND params.end_date
      ),
      period_customers AS (
        SELECT customer_id, COUNT(*) AS orders_in_period, SUM(net_sales) AS net_sales_in_period
        FROM base GROUP BY customer_id
      )
      SELECT
        COUNT(*) AS total_customers,
        COUNTIF(net_sales_in_period > 0) AS predictive_customers,
        SUM(CASE WHEN net_sales_in_period > 0 THEN orders_in_period END) AS predictive_orders,
        ROUND(SUM(CASE WHEN net_sales_in_period > 0 THEN net_sales_in_period END), 2) AS predictive_net_sales,
        COUNTIF(orders_in_period >= 2 AND net_sales_in_period > 0) AS returning_customers,
        ROUND(SUM(net_sales_in_period), 2) AS historic_net_sales,
        ROUND(
          (SUM(CASE WHEN net_sales_in_period > 0 THEN net_sales_in_period END) / NULLIF(SUM(CASE WHEN net_sales_in_period > 0 THEN orders_in_period END),0))
          * (SUM(CASE WHEN net_sales_in_period > 0 THEN orders_in_period END) * 1.0 / NULLIF(COUNTIF(net_sales_in_period > 0),0))
          * (1 / NULLIF(1 - (COUNTIF(orders_in_period >= 2 AND net_sales_in_period > 0) * 1.0 / NULLIF(COUNTIF(net_sales_in_period > 0),0)),0))
        , 2) AS ltv_preditivo,
        ROUND(SUM(net_sales_in_period) / NULLIF(COUNT(*), 0), 2) AS ltv_historico,
        ROUND(COUNTIF(orders_in_period >= 2 AND net_sales_in_period > 0) * 100.0 / NULLIF(COUNTIF(net_sales_in_period > 0), 0), 2) AS returning_rate_pct
      FROM period_customers
    `;

    const projectId = process.env.GCP_PROJECT_ID || "larroude-data-platform";
    const j = await runBQ(projectId, sql, { days });
    if (!j.jobComplete) throw new Error("BQ query não completou em 15s");
    const row = (j.rows && j.rows[0] && j.rows[0].f) || [];
    const fields = (j.schema && j.schema.fields) || [];
    const getVal = name => {
      const idx = fields.findIndex(f => f.name === name);
      return idx >= 0 ? row[idx].v : null;
    };

    return new Response(JSON.stringify({
      account, days,
      totalCustomers: Number(getVal("total_customers")) || 0,
      predictiveCustomers: Number(getVal("predictive_customers")) || 0,
      predictiveOrders: Number(getVal("predictive_orders")) || 0,
      predictiveNetSales: Number(getVal("predictive_net_sales")) || 0,
      returningCustomers: Number(getVal("returning_customers")) || 0,
      historicNetSales: Number(getVal("historic_net_sales")) || 0,
      ltvPreditivo: Number(getVal("ltv_preditivo")) || 0,
      ltvHistorico: Number(getVal("ltv_historico")) || 0,
      returningRatePct: Number(getVal("returning_rate_pct")) || 0,
      currency: account === "br" ? "BRL" : "USD",
      source: "bigquery-rest",
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=604800, stale-while-revalidate=86400"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e), fetchedAt: new Date().toISOString() }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60" } });
  }
}
