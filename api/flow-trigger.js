// Vercel Edge Function — busca o trigger source (segmento/metric/list/date_property) de UM flow.
// Endpoint: /api/flow-trigger?id=X&account=us|br
// Cache 7 dias por (account, flow_id).
// Estrutura validada com dados reais Klaviyo (revision 2025-04-15):
//   - triggers[0].type === "segment" → ID de segmento (mesmo para "Added to List" no UI)
//   - triggers[0].type === "metric"  → ID de métrica (Placed Order, Active on Site, etc)
//   - triggers[0].type === "list"    → ID de lista (raro — Klaviyo usa "segment" pra a maioria)
//   - triggers[0].type === "date_property" → propriedade do perfil (ex: $birthday)

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2025-04-15";
const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 4000;

function getApiKey(account) {
  if (account === "br") return process.env.KLAVIYO_API_KEY_BR;
  return process.env.KLAVIYO_API_KEY_US || process.env.KLAVIYO_API_KEY;
}

async function klaviyoFetchWithRetry(apiKey, path) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(KLAVIYO_BASE + path, {
      headers: {
        "Authorization": "Klaviyo-API-Key " + apiKey,
        "accept": "application/json",
        "revision": REVISION
      }
    });
    if (res.ok) return await res.json();
    if (res.status !== 429) {
      const text = await res.text();
      throw new Error("Klaviyo " + res.status + " on " + path + ": " + text.slice(0, 150));
    }
    const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
    const wait = retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_WAIT_MS) : Math.min(1000 * Math.pow(2, attempt - 1), MAX_WAIT_MS);
    last = res;
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, wait));
  }
  if (last) {
    const text = await last.text();
    throw new Error("Klaviyo 429 after retries: " + text.slice(0, 150));
  }
  throw new Error("Klaviyo unreachable");
}

async function resolveName(apiKey, type, id) {
  try {
    if (type === 'segment') {
      const j = await klaviyoFetchWithRetry(apiKey, "/segments/" + encodeURIComponent(id) + "?fields[segment]=name");
      return j?.data?.attributes?.name;
    } else if (type === 'metric') {
      const j = await klaviyoFetchWithRetry(apiKey, "/metrics/" + encodeURIComponent(id) + "?fields[metric]=name");
      return j?.data?.attributes?.name;
    } else if (type === 'list') {
      const j = await klaviyoFetchWithRetry(apiKey, "/lists/" + encodeURIComponent(id) + "?fields[list]=name");
      return j?.data?.attributes?.name;
    } else if (type === 'date_property') {
      // Date properties não precisam lookup — ID já é o nome da prop (ex: $birthday)
      return id;
    }
  } catch (_) { return null; }
  return null;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const account = (url.searchParams.get("account") || "us").toLowerCase();
  const debug = url.searchParams.get("debug") === "1";

  if (!id || !/^[A-Za-z0-9]+$/.test(id)) {
    return new Response(JSON.stringify({ error: "missing or invalid id" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (account !== "us" && account !== "br") {
    return new Response(JSON.stringify({ error: "account inválida" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const apiKey = getApiKey(account);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "KLAVIYO_API_KEY_" + account.toUpperCase() + " não configurada" }), { status: 500, headers: { "content-type": "application/json" } });
  }

  try {
    // Klaviyo revision 2025-04-15 aceita additional-fields[flow]=definition
    const j = await klaviyoFetchWithRetry(apiKey, "/flows/" + encodeURIComponent(id) + "?additional-fields%5Bflow%5D=definition");
    const attrs = j?.data?.attributes || {};
    const triggerType = attrs.trigger_type || null;  // string de display: "Added to List", "Metric", "Date Based", etc
    const def = attrs.definition || {};

    let ref = null;
    if (def.triggers && Array.isArray(def.triggers) && def.triggers.length > 0) {
      const t = def.triggers[0];
      if (t.type === 'segment' && t.id) ref = { type: 'segment', id: t.id };
      else if (t.type === 'metric' && t.id) ref = { type: 'metric', id: t.id };
      else if (t.type === 'list' && t.id) ref = { type: 'list', id: t.id };
      else if (t.type === 'date_property') {
        ref = { type: 'date_property', id: t.field || t.property || 'date' };
      }
    }

    const triggerSourceName = ref ? await resolveName(apiKey, ref.type, ref.id) : null;

    const result = {
      flow_id: id,
      account,
      triggerType,
      triggerSourceType: ref ? ref.type : null,
      triggerSourceId: ref ? ref.id : null,
      triggerSourceName: triggerSourceName,
      fetchedAt: new Date().toISOString()
    };
    if (debug) {
      result._raw_triggers = def.triggers;
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": triggerSourceName ? "public, s-maxage=604800, stale-while-revalidate=86400" : "public, s-maxage=600"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ flow_id: id, account, error: e.message, fetchedAt: new Date().toISOString() }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60" }
    });
  }
}
