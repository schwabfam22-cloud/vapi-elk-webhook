export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body || {};
  const message = body.message;

  // We support BOTH:
  // 1) tool-calls (from Elk Reservations assistant)
  // 2) end-of-call-report (from Confirmations assistant)
  if (!message || !message.type) {
    return res.status(200).json({ ok: true });
  }

  // -----------------------------
  // END OF CALL REPORT (Retries)
  // -----------------------------
  if (message.type === "end-of-call-report") {
    try {
      const call = message.call;
      const assistantId = call?.assistantId || call?.assistant?.id;

      // Only process confirmations assistant calls
      const CONFIRMATIONS_ASSISTANT_ID = "a9196290-4c32-4501-aa78-b8a4dd72034f";
      const CONFIRMATIONS_PHONE_NUMBER_ID = "0bfcb36a-5623-4d33-a711-d1891f15d7f8";

      if (assistantId !== CONFIRMATIONS_ASSISTANT_ID) {
        return res.status(200).json({ ok: true, ignored: "not-confirmations-assistant" });
      }

      const endedReason = call?.endedReason;
      const callId = call?.id;

      // Find the log by latest_call_id == this callId
      const logs = await base44List("ConfirmationLog");
      const log = logs.find((r) => {
        const fields = r.fields || r;
        return String(fields.latest_call_id || "").trim() === String(callId || "").trim();
      });

      if (!log) {
        // If no log found, do nothing (prevents accidental retry loops)
        return res.status(200).json({ ok: true, warning: "No ConfirmationLog found for callId", callId });
      }

      const fields = log.fields || log;
      const attemptCount = Number(fields.attempt_count || 0);

      // Update last ended reason + status
      await base44Update("ConfirmationLog", log.id || log._id, {
        last_ended_reason: String(endedReason || ""),
        status: endedReason === "customer-did-not-answer" ? "retry_pending" : "completed"
      });

      // If they didn't answer, schedule retries (max 2 retries)
      if (endedReason === "customer-did-not-answer") {
        if (attemptCount === 0) {
          // retry in 10 minutes
          const nextAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          const scheduled = await vapiScheduleCall({
            assistantId: CONFIRMATIONS_ASSISTANT_ID,
            phoneNumberId: CONFIRMATIONS_PHONE_NUMBER_ID,
            customerNumber: String(fields.customer_phone || "").trim(),
            earliestAt: nextAt
          });

          await base44Update("ConfirmationLog", log.id || log._id, {
            attempt_count: 1,
            status: scheduled.ok ? "retry_scheduled" : "retry_schedule_failed",
            next_call_at: nextAt,
            latest_call_id: scheduled.ok ? (scheduled.response?.id || fields.latest_call_id) : fields.latest_call_id
          });

          return res.status(200).json({ ok: true, retry: "10min", scheduled });
        }

        if (attemptCount === 1) {
          // retry in 60 minutes
          const nextAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          const scheduled = await vapiScheduleCall({
            assistantId: CONFIRMATIONS_ASSISTANT_ID,
            phoneNumberId: CONFIRMATIONS_PHONE_NUMBER_ID,
            customerNumber: String(fields.customer_phone || "").trim(),
            earliestAt: nextAt
          });

          await base44Update("ConfirmationLog", log.id || log._id, {
            attempt_count: 2,
            status: scheduled.ok ? "retry_scheduled" : "retry_schedule_failed",
            next_call_at: nextAt,
            latest_call_id: scheduled.ok ? (scheduled.response?.id || fields.latest_call_id) : fields.latest_call_id
          });

          return res.status(200).json({ ok: true, retry: "60min", scheduled });
        }

        // attemptCount >= 2 -> stop
        await base44Update("ConfirmationLog", log.id || log._id, {
          status: "failed",
          next_call_at: ""
        });

        return res.status(200).json({ ok: true, retry: "none-left" });
      }

      // Answered / other ended reason: mark completed
      await base44Update("ConfirmationLog", log.id || log._id, {
        status: "completed",
        next_call_at: ""
      });

      return res.status(200).json({ ok: true, completed: true });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e?.message || e) });
    }
  }

  // -----------------------------
  // TOOL CALLS
  // -----------------------------
  if (message.type !== "tool-calls") {
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

    // --------------------------
    // submit_reservation
    // --------------------------
    if (name === "submit_reservation") {
      const RESERVATION_ENTITY = "Reservation";

      const toNumber = String(args.phone_number || "").trim();

      const payload = {
        gown_number: String(args.gown_number || "").trim(),
        phone_number: toNumber,
        name: String(args.name || "").trim(),
        email: String(args.email_address || "").trim(),
        reservation_date: String(args.date || "").trim(),
        gown_returned: false,
        notes: "",
        call_sent: true
      };

      // 1) Write reservation to Base44
      const write = await base44Create(RESERVATION_ENTITY, payload);

      if (!write.ok) {
        results.push({
          toolCallId,
          result: {
            ok: false,
            reservationWritten: false,
            base44: write
          }
        });
        continue;
      }

      const reservationId = write.response?.id || write.response?._id || write.response?.data?.id || null;

      // 2) Schedule confirmation call +90 minutes (reservation should succeed even if call scheduling fails)
      const earliestAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();

      const scheduled = await vapiScheduleCall({
        assistantId: "a9196290-4c32-4501-aa78-b8a4dd72034f",
        phoneNumberId: "0bfcb36a-5623-4d33-a711-d1891f15d7f8",
        customerNumber: toNumber,
        earliestAt
      });

      // 3) Create ConfirmationLog record (do not touch Reservation)
      const logCreate = await base44Create("ConfirmationLog", {
        reservation_id: reservationId ? String(reservationId) : "",
        customer_phone: toNumber,
        initial_call_id: scheduled.ok ? String(scheduled.response?.id || "") : "",
        latest_call_id: scheduled.ok ? String(scheduled.response?.id || "") : "",
        attempt_count: 0,
        status: scheduled.ok ? "scheduled" : "schedule_failed",
        next_call_at: earliestAt,
        last_ended_reason: ""
      });

      results.push({
        toolCallId,
        result: {
          ok: true,
          reservationWritten: true,
          base44Reservation: write,
          confirmationScheduled: scheduled, // may be ok:false; reservation still succeeded
          confirmationLog: logCreate // best-effort
        }
      });

      continue;
    }

    // --------------------------
    // check_gown_availability
    // --------------------------
    if (name === "check_gown_availability") {
      const gown = String(args.gown_number || "").trim();
      const dateStr = String(args.date || "").trim();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        results.push({
          toolCallId,
          result: {
            ok: false,
            error: "Date must be YYYY-MM-DD (include year).",
            received: dateStr
          }
        });
        continue;
      }

      const target = new Date(dateStr + "T00:00:00Z");
      if (isNaN(target.getTime())) {
        results.push({
          toolCallId,
          result: { ok: false, error: "Invalid date.", received: dateStr }
        });
        continue;
      }

      // Window: [target-9d, target+3d]
      const start = new Date(target);
      start.setUTCDate(start.getUTCDate() - 9);

      const end = new Date(target);
      end.setUTCDate(end.getUTCDate() + 3);

      const list = await base44List("Reservation");
      if (!list.ok) {
        results.push({
          toolCallId,
          result: { ok: false, error: "Failed to list reservations", details: list }
        });
        continue;
      }

      const rows = list.rows;
      const conflicts = [];

      for (const r of rows) {
        const fields = r.fields || r;

        const rGown = String(fields.gown_number || "").trim();
        if (!rGown || rGown !== gown) continue;

        const rDateStr = String(fields.reservation_date || fields.date || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rDateStr)) continue;

        const rDate = new Date(rDateStr + "T00:00:00Z");
        if (isNaN(rDate.getTime())) continue;

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

    results.push({
      toolCallId,
      result: { ok: false, error: `No handler implemented for ${name}` }
    });
  }

  return res.status(200).json({ results });
}

/** --------------------------
 *  Vapi helper
 *  -------------------------- */
async function vapiScheduleCall({ assistantId, phoneNumberId, customerNumber, earliestAt }) {
  if (!process.env.VAPI_PRIVATE_KEY) {
    return { ok: false, error: "Missing VAPI_PRIVATE_KEY env var" };
  }

  const resp = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      assistantId,
      phoneNumberId,
      customer: { number: customerNumber },
      schedulePlan: { earliestAt }
    })
  });

  const data = await safeReadJson(resp);

  return {
    ok: resp.ok,
    status: resp.status,
    earliestAt,
    response: data
  };
}

/** --------------------------
 *  Base44 helpers
 *  -------------------------- */
const BASE44_APP_ID = "6993becb0552ab79e616a46d";
const BASE44_BASE_URL = `https://ezralkallahreservations.base44.app/api/apps/${BASE44_APP_ID}/entities`;

async function base44Create(entityName, fields) {
  try {
    const url = `${BASE44_BASE_URL}/${encodeURIComponent(entityName)}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        api_key: process.env.BASE44_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(fields)
    });

    const data = await safeReadJson(resp);

    return { ok: resp.ok, status: resp.status, response: data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function base44List(entityName) {
  try {
    const url = `${BASE44_BASE_URL}/${encodeURIComponent(entityName)}`;

    const resp = await fetch(url, {
      headers: {
        api_key: process.env.BASE44_API_KEY,
        "Content-Type": "application/json"
      }
    });

    const data = await safeReadJson(resp);

    if (!resp.ok) return { ok: false, status: resp.status, response: data };

    const rows = normalizeBase44List(data);
    return { ok: true, status: resp.status, rows };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function base44Update(entityName, id, fields) {
  try {
    if (!id) return { ok: false, error: "Missing Base44 record id" };

    // Many Base44 installs support PATCH /entities/<Entity>/<id>
    const url = `${BASE44_BASE_URL}/${encodeURIComponent(entityName)}/${encodeURIComponent(id)}`;

    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        api_key: process.env.BASE44_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(fields)
    });

    const data = await safeReadJson(resp);

    return { ok: resp.ok, status: resp.status, response: data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** --------------------------
 *  Generic helpers
 *  -------------------------- */
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

function normalizeBase44List(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.entities)) return data.entities;
  return [];
}
