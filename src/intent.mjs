// Turns "send $10 to Ada" into { to, amount }. The model only ever returns a contact NAME and a
// number; the code resolves the name to an allow-listed address and enforces every limit.
// Works without any API key (regex fallback). With ANTHROPIC_API_KEY set, a model handles looser phrasing.

export function parseSimple(text) {
  const m = String(text).match(/send\s+\$?\s*(\d+(?:\.\d+)?)\s*(?:usd[t₮]?|dollars?|bucks)?\s+to\s+([a-z][\w .'-]*?)\s*(?:in\s+(?:naira|ngn|cngn))?\s*[.!]?$/i);
  return m ? { amount: m[1], to: m[2].trim() } : null;
}

export async function parseIntent(text, contactNames) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const simple = parseSimple(text);
    if (!simple) throw new Error('Could not understand. Try: send $10 to ada  (or set ANTHROPIC_API_KEY for free-form requests)');
    return simple;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
      max_tokens: 150,
      system:
        "You extract a payment request. Reply with ONLY compact JSON: " +
        '{"contact": <one of the allowed names, lowercase, or null>, "amount_usd": <decimal string or null>}. ' +
        "Never invent names. If unsure, use null. Allowed names: " + JSON.stringify(contactNames),
      messages: [{ role: "user", content: String(text).slice(0, 500) }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Model request failed (${res.status})`);
  const body = await res.json();
  const raw = body.content?.find((c) => c.type === "text")?.text ?? "";
  let parsed;
  try { parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { parsed = null; }
  if (!parsed?.contact || !parsed?.amount_usd) throw new Error("The request was unclear (need a known contact and an amount).");
  return { to: String(parsed.contact), amount: String(parsed.amount_usd) };
}
