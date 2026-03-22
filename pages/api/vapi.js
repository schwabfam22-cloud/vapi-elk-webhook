export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  const message = body.message;

  // ACK all non-tool events so Vapi doesn't keep retrying
  if (!message || message.type !== "tool-calls") {
    return res.status(200).json({ ok: true });
  }

  const toolCallList = message.toolCallList || [];

  // Temporary stub responses so the call doesn't break.
  // We'll update this once we see the exact payload shape in webhook logs.
  const results = toolCallList.map((tc, idx) => ({
    toolCallId: tc.id || tc.toolCallId || String(idx),
    result: { ok: true, stub: true }
  }));

  return res.status(200).json({ results });
}
