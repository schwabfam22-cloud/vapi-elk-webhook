export const runtime = "nodejs";

type Body = {
  reservationId: string;            // REQUIRED for idempotency
  name: string;
  gown_number: string;
  reservation_date: string;
  customer_phone: string;
  delayMinutes?: number;            // default 60
};

function toE164US(input: string): string {
  const raw = String(input ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw new Error(`Invalid US phone number: ${input}`);
}

function isoInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Simple in-memory idempotency cache (works per-server-instance).
// For real durability, store this in Base44 or a DB.
const seen = new Set<string>();

export async function POST(req: Request) {
  try {
    // ---- (A) Optional auth gate (recommended) ----
    // Set this env var if you want protection:
    // RESERVATION_WEBHOOK_SECRET = some-long-random-string
    const secret = process.env.RESERVATION_WEBHOOK_SECRET;
    if (secret) {
      const got = req.headers.get("x-webhook-secret");
      if (got !== secret) {
        return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      }
    }

    // ---- (B) Parse + validate body ----
    const body = (await req.json()) as Partial<Body>;

    if (!body.reservationId) throw new Error("Missing field: reservationId");
    if (!body.name) throw new Error("Missing field: name");
    if (!body.gown_number) throw new Error("Missing field: gown_number");
    if (!body.reservation_date) throw new Error("Missing field: reservation_date");
    if (!body.customer_phone) throw new Error("Missing field: customer_phone");

    // ---- (C) Idempotency (avoid duplicate schedules) ----
    // If Base44 retries the request, we do nothing.
    if (seen.has(body.reservationId)) {
      return Response.json({
        ok: true,
        deduped: true,
        reservationId: body.reservationId
      });
    }
    seen.add(body.reservationId);

    // ---- (D) Build Vapi payload ----
    const VAPI_PRIVATE_KEY = getEnv("VAPI_PRIVATE_KEY");

    const assistantId = "a9196290-4c32-4501-aa78-b8a4dd72034f";
    const phoneNumberId = "0bfcb36a-5623-4d33-a711-d1891f15d7f8";

    const delayMinutes =
      Number.isFinite(body.delayMinutes as number) ? Number(body.delayMinutes) : 60;

    const earliestAt = isoInMinutes(delayMinutes);
    const customerNumber = toE164US(body.customer_phone);

    const vapiBody = {
      assistantId,
      phoneNumberId,
      customer: { number: customerNumber },
      schedulePlan: { earliestAt },
      assistantOverrides: {
        variableValues: {
          // IMPORTANT: make your assistant use {{name}}, {{gown_number}}, {{reservation_date}}
          name: body.name,
          gown_number: body.gown_number,
          reservation_date: body.reservation_date,
          reservationId: body.reservationId
        }
      }
    };

    // ---- (E) Call Vapi ----
    const resp = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(vapiBody)
    });

    const text = await resp.text();
    if (!resp.ok) {
      // If Vapi fails, allow retry by removing the idempotency mark
      seen.delete(body.reservationId);
      throw new Error(`Vapi error (${resp.status}): ${text}`);
    }

    const vapiCall = JSON.parse(text);

    return Response.json({
      ok: true,
      reservationId: body.reservationId,
      scheduledFor: earliestAt,
      vapi: {
        callId: vapiCall.id,
        status: vapiCall.status,
        to: vapiCall.customer?.number
      }
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Unknown error" },
      { status: 400 }
    );
  }
}
