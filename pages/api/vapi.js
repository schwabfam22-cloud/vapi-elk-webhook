/**
 * NEXT.JS (VERCEL) — App Router API route
 * Paste this into: app/api/reservation-created/route.ts
 *
 * What it does:
 * - Receives JSON from Base44 (or anything) when a reservation is created
 * - Schedules a Vapi outbound call for 1 hour later
 *
 * REQUIRED VERCEL ENV VAR:
 * - VAPI_PRIVATE_KEY = your Vapi private API key (UUID format)
 *
 * Your Vapi resources (already in your org):
 * - assistantId: a9196290-4c32-4501-aa78-b8a4dd72034f  (Confirmations)
 * - phoneNumberId: 0bfcb36a-5623-4d33-a711-d1891f15d7f8 (from +16268777624)
 */

export const runtime = "nodejs";

type Body = {
  // These are the fields you should send from Base44.
  // If your Base44 field names differ, either:
  // 1) change them at the source, or
  // 2) map them below.
  name: string;
  gown_number: string;
  reservation_date: string; // any string your prompt should speak (e.g. "2026-03-30")
  customer_phone: string; // "8482233204" or "+18482233204"
  delayMinutes?: number; // optional override (default 60)
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

async function scheduleVapiCall(body: Body) {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) throw new Error("Missing env var VAPI_PRIVATE_KEY (set it in Vercel)");

  const assistantId = "a9196290-4c32-4501-aa78-b8a4dd72034f";
  const phoneNumberId = "0bfcb36a-5623-4d33-a711-d1891f15d7f8";

  const delayMinutes = Number.isFinite(body.delayMinutes as number)
    ? Number(body.delayMinutes)
    : 60;

  const earliestAt = isoInMinutes(delayMinutes);
  const customerNumber = toE164US(body.customer_phone);

  const payload = {
    assistantId,
    phoneNumberId,
    customer: { number: customerNumber },
    schedulePlan: { earliestAt },

    // RECOMMENDED:
    // Update your assistant firstMessage to use flat vars:
    // {{name}}, {{gown_number}}, {{reservation_date}}
    assistantOverrides: {
      variableValues: {
        name: body.name,
        gown_number: body.gown_number,
        reservation_date: body.reservation_date
      }
    }
  };

  const resp = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Vapi POST /call failed (${resp.status}): ${text}`);
  }

  return await resp.json();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<Body>;

    // Basic validation
    if (!body.name) throw new Error("Missing field: name");
    if (!body.gown_number) throw new Error("Missing field: gown_number");
    if (!body.reservation_date) throw new Error("Missing field: reservation_date");
    if (!body.customer_phone) throw new Error("Missing field: customer_phone");

    const vapiCall = await scheduleVapiCall(body as Body);

    return Response.json({
      ok: true,
      scheduled: {
        callId: vapiCall.id,
        status: vapiCall.status,
        customer: vapiCall.customer?.number,
        earliestAt: vapiCall.schedulePlan?.earliestAt ?? null
      }
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Unknown error" },
      { status: 400 }
    );
  }
}

/**
 * QUICK TEST (after deploy):
 * curl -X POST "https://YOUR-VERCEL-DOMAIN.vercel.app/api/reservation-created" \
 *  -H "Content-Type: application/json" \
 *  -d '{
 *    "name":"Alyssa",
 *    "gown_number":"127",
 *    "reservation_date":"2026-03-30",
 *    "customer_phone":"8482233204",
 *    "delayMinutes": 60
 *  }'
 */
