// Vercel Edge Function — busca nomes/subjects das mensagens de UM flow.
// Endpoint: /api/flow-messages?account=us|br&id=FLOW_ID
// Retorna: { messages: [{id, name, subject_line, preview_text, position}] }
// Cache 7 dias.

export const config = { runtime: "edge" };

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const REVISION = "2025-04-15";
const MAX_ATTEMPTS = 5;

function getApiKey(account) {
  if (account === "br") return process.env.KLAVIYO_API_KEY_BR;
  return process.env.KLAVIYO_API_KEY_US || process.env.KLAVIYO_API_KEY;
}

async function klaviyoFetch(apiKey, path) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(KLAVIYO_BASE + path, {
      headers: { "Authorization": "Klaviyo-API-Key " + apiKey, "accept": "application/json", "revision": REVISION }
    });
    if (res.ok) return await res.json();
    if (res.status !== 429) {
      const t = await res.text();
      throw new Error("Klaviyo " + res.status + ": " + t.slice(0, 150));
    }
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const wait = ra > 0 ? Math.min(ra * 1000, 4000) : Math.min(1000 * Math.pow(2, attempt - 1), 4000);
    last = res;
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, wait));
  }
  if (last) throw new Error("Klaviyo 429 retries: " + (await last.text()).slice(0, 100));
  throw new Error("unreachable");
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const account = (url.searchParams.get("account") || "us").toLowerCase();
  if (!id || !/^[A-Za-z0-9]+$/.test(id)) return new Response(JSON.stringify({ error: "missing or invalid id" }), { status: 400, headers: { "content-type": "application/json" } });
  if (!["us", "br"].includes(account)) return new Response(JSON.stringify({ error: "account inválida" }), { status: 400, headers: { "content-type": "application/json" } });
  const apiKey = getApiKey(account);
  if (!apiKey) return new Response(JSON.stringify({ error: "API key não configurada" }), { status: 500, headers: { "content-type": "application/json" } });

  try {
    // /flows/{id}/flow-messages — retorna todas mensagens com name, subject_line, position
    const j = await klaviyoFetch(apiKey, "/flows/" + encodeURIComponent(id) + "/flow-messages?fields[flow-message]=name,definition,content,created,updated&page[size]=50");
    const messages = (j.data || []).map(m => {
      const a = m.attributes || {};
      const def = a.definition || {};
      const content = a.content || {};
      return {
        id: m.id,
        name: a.name || null,
        subject_line: content.subject || def.content?.subject || a.subject_line || null,
        preview_text: content.preview_text || def.content?.preview_text || null,
        created: a.created,
        updated: a.updated
      };
    });

    return new Response(JSON.stringify({
      flow_id: id, account, messages, count: messages.length,
      fetchedAt: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": messages.length > 0 ? "public, s-maxage=604800, stale-while-revalidate=86400" : "public, s-maxage=600"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ flow_id: id, account, error: e.message }), {
      status: 200, headers: { "content-type": "application/json", "cache-control": "public, s-maxage=60" }
    });
  }
}
