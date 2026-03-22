export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const { message } = req.body || {};

  // Always ACK non-tool events (status updates, transcripts, etc.)
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
        ? safeJsonParse(tc.function.arguments, {})
        : (tc.function?.arguments || tc.arguments || {});

    // --- submit_reservation: write to Base44 ---
    if (name === "submit_reservation") {
      const base44Url =
        "https://ezralkallahreservations.base44.app/api/apps/6993becb0552ab79e616a46d/entities/Reservation";

      const payload = {
        gown_number: String(args.gown_number || "").trim(),
        phone_number: String(args.phone_number || "").trim(),
        name: String(args.name || "").trim(),
        email: String(args.email_address || "").trim(),
        reservation_date: String(args.date || "").trim(),
        gown_returned: false,
        // notes intentionally blank unless you later add a notes param
        notes: "",
        call_sent: true
      };

      const resp = await fetch(base44Url, {
        method: "POST",
        headers: {
          api_key: process.env.BASE44_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await safeReadJson(resp);

      results.push({
        toolCallId,
        result: {
          ok: resp.ok,
          status: resp.status,
          reservation: resp.ok ? data : null,
          error: resp.ok ? null : data,
          writtenFields: payload
        }
      });

      continue;
    }

    // --- check_gown_availability: check Base44 reservations ---
    if (name === "check_gown_availability") {
      const gown = String(args.gown_number || "").trim();
      const dateStr = String(args.date || "").trim(); // model often sends YYYY-MM-DD

      const target = parseDateAsUTC(dateStr);
      if (!target) {
        results.push({
          toolCallId,
          result: { ok: false, error: "Invalid date. Please use YYYY-MM-DD.", received: dateStr }
        });
        continue;
      }

      const start = new Date(target);
      start.setUTCDate(start.getUTCDate() - 9);

      const end = new Date(target);
      end.setUTCDate(end.getUTCDate() + 3);

      const base44Url =
        "https://ezralkallahreservations.base44.app/api/apps/6993becb0552ab79e616a46d/entities/Reservation";

      const resp = await fetch(base44Url, {
        headers: {
          api_key: process.env.BASE44_API_KEY,
          "Content-Type": "application/json"
        }
      });

      const data = await safeReadJson(resp);

      if (!resp.ok) {
        results.push({
          toolCallId,
          result: { ok: false, status: resp.status, error: data }
        });
        continue;
      }

      const rows = normalizeBase44List(data);
      const conflicts = [];

      for (const r of rows) {
        const fields = r.fields || r;

        const rGown = String(fields.gown_number || "").trim();
        if (!rGown || rGown !== gown) continue;

        const rDateStr = String(fields.reservation_date || fields.date || "").trim();
        const rDate = parseDateAsUTC(rDateStr);
        if (!rDate) continue;

        if (rDate >= start && rDate <= end) {
          conflicts.push({
            id: r.id || r._id || null,
            gown_number: rGown,
            reservation_date: rDateStr,
            name: fields.name || null,
            phone_number: fields.phone_number || null
          });
        }
      }

      results.push({
        toolCallId,
        result: {
          ok: true,
          available: conflicts.length === 0,
          gown_number: gown,
          targetDate: dateStr,
          window: {
            start: start.toISOString().slice(0, 10),
            end: end.toISOString().slice(0, 10)
          },
          conflictCount: conflicts.length,
          conflicts
        }
      });

      continue;
    }

    // --- default ---
    results.push({
      toolCallId,
      result: { ok: false, error: `No handler implemented for ${name}` }
    });
  }

  return res.status(200).json({ results });
}

/** Helpers */

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

async function safeReadJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Accepts YYYY-MM-DD or any Date-parsable string; returns Date at 00:00Z if possible
function parseDateAsUTC(s) {
  if (!s) return null;

  // If already YYYY-MM-DD, force midnight UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00Z");
    return isNaN(d.getTime()) ? null : d;
  }

  // Fallback: let JS parse, then normalize to date-only UTC
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function normalizeBase44List(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.entities)) return data.entities;
  return [];
}
