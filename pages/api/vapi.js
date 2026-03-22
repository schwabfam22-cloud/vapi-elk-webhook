export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const { message } = req.body || {};

  // Always ACK non-tool events
  if (!message || message.type !== "tool-calls") {
    return res.status(200).json({ ok: true });
  }

  const toolCallList = message.toolCallList || [];
  const results = [];

  for (const tc of toolCallList) {
    const toolCallId = tc.id || tc.toolCallId;
    const name = tc.function?.name || tc.name;
    const args =
      typeof tc.function?.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : (tc.function?.arguments || tc.arguments || {});

    if (name === "submit_reservation") {
      // Map Vapi args -> Base44 fields
      const payloadFlat = {
        gown_number: String(args.gown_number || ""),
        phone_number: String(args.phone_number || ""),
        name: String(args.name || ""),
        email: String(args.email_address || ""),
        reservation_date: String(args.date || ""),
        notes: "",
        call_sent: true
      };

      const base44Url =
        "https://ezralkallahreservations.base44.app/api/apps/6993becb0552ab79e616a46d/entities/Reservation";

      // Try the simplest format first: send fields flat
      let resp = await fetch(base44Url, {
        method: "POST",
        headers: {
          "api_key": process.env.BASE44_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payloadFlat)
      });

      // If Base44 expects wrapped payloads, we’ll see an error and adjust
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      results.push({
        toolCallId,
        result: {
          ok: resp.ok,
          status: resp.status,
          base44Response: data,
          attemptedPayload: payloadFlat
        }
      });

      continue;
    }

    // Default for other tools for now
    results.push({
      toolCallId,
      result: { ok: true, note: `No handler for ${name} yet` }
    });
  }

  return res.status(200).json({ results });
}
