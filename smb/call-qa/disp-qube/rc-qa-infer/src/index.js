/**
 * rc-qa-infer — disp-qube. Two verbs, both observations: /transcribe (audio bytes → text)
 * and /grade (transcript → four subscores + outcome + flag + notes). The model IDs and input
 * contracts are the corrected ones: whisper-large-v3-turbo takes BASE64 (the bytes-array
 * contract belongs to @cf/openai/whisper); llama-3.3-70b-instruct-fp8-fast is the JSON-mode
 * variant and is driven with a json_schema. A schema miss is an ERROR from Workers AI, not
 * bad JSON — it is caught and returned as NO_SIGNAL. total_score is not in the schema on
 * purpose: policy computes it. fabricated:false
 */
import { Buffer } from "node:buffer";
export const WHISPER = "@cf/openai/whisper-large-v3-turbo";
export const LLM = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const RUBRIC_VERSION = "client-rubric-example+wayne-smb-v1";   // the client verbatim KPI logic + Wayne internal coaching rubric
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;   // ~15 min of phone MP3 is well under this
export const MAX_TRANSCRIPT_CHARS = 60000;         // ~15k tokens, inside the 24k context with the rubric

export const SCHEMA = Object.freeze({
  type: "object",
  properties: {
    greeting_score: { type: "integer", minimum: 1, maximum: 5 },
    discovery_score: { type: "integer", minimum: 1, maximum: 5 },
    action_score: { type: "integer", minimum: 1, maximum: 5 },
    empathy_score: { type: "integer", minimum: 1, maximum: 5 },
    qualified: { type: "boolean" },
    intake_outcome: { type: "string", enum: ["Scheduled", "Will Call Back", "Pricing Concerns", "No Next Steps", "Not Qualified", "Complaint"] },
    service_type: { type: "string" },
    hostility_flag: { type: "boolean" },
    strengths: { type: "string" },
    coaching_note: { type: "string" },
  },
  required: ["greeting_score", "discovery_score", "action_score", "empathy_score", "qualified", "intake_outcome", "service_type", "hostility_flag", "strengths", "coaching_note"],
});

export const SYSTEM = `Act as an expert automotive shop operations coach and data analyst. You are analyzing ONE
call transcript between an intake staff member at a the client location and a
customer. Observe; do not decide. Every KPI is computed downstream from what you report.

the client network reporting logic (the client's operations lead, Director of Store Operations — verbatim):
1. A lead is considered "Scheduled" if the \`Intakes\` column contains the word "Scheduled".
2. A lead is considered "Lost" if it is Qualified but does NOT contain "Scheduled" in the \`Intakes\` column.
3. Financial metrics are calculated by summing the dollar amounts in the \`Value\` column for Scheduled (Captured) vs. Lost leads.
4. Group any blank, NaN, or "-" entries in the \`AI Answered By\` column into a single "Unassigned" category.

Applied to this transcript, report:
- qualified: true when the caller has a service need the shop could schedule (a prospective or
  current customer); false for wrong numbers, vendors, personal calls, spam.
- intake_outcome: exactly one of "Scheduled", "Will Call Back", "Pricing Concerns", "No Next Steps",
  "Not Qualified", "Complaint" — the Intakes outcome as the client names them.
- service_type: the service discussed, in a few words (brakes, diagnostic, oil change, AC, alignment,
  inspection, unknown).
Do not estimate dollar values. The Value column is not in the transcript.

Wayne coaching rubric (internal, domain-wide). Score each category 1-5:
- greeting_score: stated the shop name, polite and branded introduction.
- discovery_score: asked clarifying questions, understood the customer's actual issue.
- action_score: attempted to book an appointment or recommend a relevant service.
- empathy_score: professional, patient, non-defensive tone throughout.

Set hostility_flag true if the customer became hostile, threatened a negative review, or demanded a
manager. strengths: what the staff member did well (wins), naming the service type when scheduled.
coaching_note: one specific, actionable instruction — "The Why" in the client's language where it applies:
acting as an estimator instead of an appointment setter, failing to overcome price objections on
diagnostics, letting the customer off the phone without securing a calendar slot.

Report only what the transcript supports. Do not infer facts not present.
Respond only with JSON matching the schema. No preamble, no markdown.`;

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const noSignal = (reason, status = 502, more = {}) => json({ membrane: "NO_SIGNAL", reason, ...more, fabricated: false }, status);

export async function transcribe(env, buf) {
  const audio = Buffer.from(buf).toString("base64");
  const r = await env.AI.run(WHISPER, { audio, language: "en" });
  return { text: String((r && r.text) || ""), model: WHISPER, bytes: buf.byteLength };
}

export async function grade(env, transcript) {
  const r = await env.AI.run(LLM, {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Transcript:\n${transcript}` }],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    temperature: 0.1, max_tokens: 700,
  });
  const out = typeof r.response === "string" ? JSON.parse(r.response) : r.response;
  if (!out || typeof out !== "object") throw new Error("model returned no object");
  delete out.total_score;   // never accepted from the model even if it volunteers one
  return { observations: out, model: LLM, rubric_version: RUBRIC_VERSION };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const m = request.method.toUpperCase();
    if (path === "/health" && m === "GET") return json({ service: "rc-qa-infer", layer: "disp-qube", routed: false, models: { transcribe: WHISPER, grade: LLM }, rubric_version: RUBRIC_VERSION, returns: "observations only — no policy, no D1, no SMS, no credentials", fabricated: false });
    if (!env.AI) return noSignal("binding AI absent", 503);
    if (path === "/transcribe" && m === "POST") {
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > MAX_AUDIO_BYTES) return noSignal(`audio ${declared}B exceeds ${MAX_AUDIO_BYTES}B`, 413);
      const buf = await request.arrayBuffer();
      if (buf.byteLength === 0) return noSignal("empty audio", 400);
      if (buf.byteLength > MAX_AUDIO_BYTES) return noSignal(`audio ${buf.byteLength}B exceeds ${MAX_AUDIO_BYTES}B`, 413);
      try { return json({ ...(await transcribe(env, buf)), fabricated: false }); }
      catch (e) { return noSignal(`transcribe failed: ${String((e && e.message) || e).slice(0, 300)}`, 502, { model: WHISPER }); }
    }
    if (path === "/grade" && m === "POST") {
      let b; try { b = await request.json(); } catch (_) { return noSignal("body is not JSON", 400); }
      const transcript = String((b && b.transcript) || "").trim();
      if (!transcript) return noSignal("transcript empty", 400);
      if (transcript.length > MAX_TRANSCRIPT_CHARS) return noSignal(`transcript ${transcript.length} chars exceeds ${MAX_TRANSCRIPT_CHARS}`, 413);
      try { return json({ ...(await grade(env, transcript)), fabricated: false }); }
      catch (e) { return noSignal(`grade failed: ${String((e && e.message) || e).slice(0, 300)}`, 502, { model: LLM }); }   // "JSON Mode couldn't be met" lands here
    }
    return noSignal(`no route ${m} ${path}`, 404);
  },
};
