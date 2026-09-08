/**
 * policy.js — the alert gate. Pure, unit-tested, no I/O. sys-firewall owns policy;
 * disp-qube returns observations only. total_score is computed HERE from the four
 * subscores; the model never reports a sum. The 3-minute lost-lead rule reads duration
 * from the call-log metadata the model never saw. fabricated:false
 */
export const LOW_SCORE_THRESHOLD = 12;        // out of 20
export const LOST_LEAD_MIN_SEC = 180;         // 3 minutes
export const ALERT_CAP_PER_HOUR = 4;          // anti-fatigue: above this, suppress into a digest
export const SUBSCORES = Object.freeze(["greeting_score", "discovery_score", "action_score", "empathy_score"]);
export const OUTCOMES = Object.freeze(["booked", "inquiry", "complaint", "lost_lead"]);
/** the client's Intakes outcomes, the client's wording (rubric/client-rubric-example.json) */
export const INTAKE_OUTCOMES = Object.freeze(["Scheduled", "Will Call Back", "Pricing Concerns", "No Next Steps", "Not Qualified", "Complaint"]);
export const LOST_WHYS = Object.freeze(["Will Call Back", "Pricing Concerns", "No Next Steps"]);
/** rule 1 */ export const isScheduled = (g) => g.intake_outcome === "Scheduled";
/** rule 2: Qualified AND not Scheduled (a complaint is not a lead) */ export const isLost = (g) => g.qualified === true && !isScheduled(g) && g.intake_outcome !== "Complaint";
/** the legacy call_outcome column, derived — never asked of the model */
export function callOutcome(g) { if (isScheduled(g)) return "booked"; if (g.intake_outcome === "Complaint") return "complaint"; if (isLost(g)) return "lost_lead"; return "inquiry"; }
/** rule 4, with the shared lines folded in: a Department extension or a shared desk/office/main line cannot be coached as a person, so it groups as Unassigned (the line is kept in `via`) */
export const staffOf = (rep, shared = false) => (!shared && rep && String(rep).trim()) ? String(rep).trim() : "Unassigned";
export function parseStoreMap(raw) {
  try { const m = typeof raw === "string" ? JSON.parse(raw) : (raw || {}); return { numbers: m.store_of_number || {}, extensions: m.extension_store || {}, shared: m.shared_extensions || {} }; } catch (_) { return { numbers: {}, extensions: {}, shared: {} }; }
}
/** the store a call belongs to: the shop-side number first (dialed number inbound, caller id outbound), then the extension's measured majority, else UNKNOWN — never a default */
export function storeOf(map, call) {
  const side = call.direction === "Inbound" ? call.to_number : call.from_number;
  if (side && map.numbers[side]) return map.numbers[side];
  const other = call.direction === "Inbound" ? call.from_number : call.to_number;
  if (other && map.numbers[other]) return map.numbers[other];
  if (call.extension_id && map.extensions[String(call.extension_id)]) return map.extensions[String(call.extension_id)];
  return "UNKNOWN";
}
export const isSharedLine = (map, extId) => !!(extId && map.shared[String(extId)]);

/** Validate a disp-qube observation set. Returns [] when sound, else the defects (the run goes red, not silent). */
export function validateObservations(g) {
  const bad = [];
  if (!g || typeof g !== "object") return ["observations missing"];
  for (const k of SUBSCORES) { const v = g[k]; if (!Number.isInteger(v) || v < 1 || v > 5) bad.push(`${k} must be an integer 1..5, got ${JSON.stringify(v)}`); }
  if (typeof g.qualified !== "boolean") bad.push("qualified must be boolean");
  if (!INTAKE_OUTCOMES.includes(g.intake_outcome)) bad.push(`intake_outcome must be one of ${INTAKE_OUTCOMES.join("|")}, got ${JSON.stringify(g.intake_outcome)}`);
  if (typeof g.service_type !== "string") bad.push("service_type must be a string");
  if ("call_outcome" in g) bad.push("the model must not report call_outcome; policy derives it from intake_outcome");
  if (typeof g.hostility_flag !== "boolean") bad.push("hostility_flag must be boolean");
  if (typeof g.coaching_note !== "string") bad.push("coaching_note must be a string (empty means nothing to coach)");
  if ("total_score" in g) bad.push("the model must not report total_score; policy computes it");
  return bad;
}

export const totalScore = (g) => SUBSCORES.reduce((s, k) => s + g[k], 0);

/** @returns {{code:"ESCALATION"|"LOW_SCORE"|"LOST_LEAD", reason:string}|null} */
export function evaluateGate(g, call) {
  const total = totalScore(g);
  if (g.hostility_flag) return { code: "ESCALATION", reason: "Customer escalated or threatened a review" };
  if (total < LOW_SCORE_THRESHOLD) return { code: "LOW_SCORE", reason: `Score ${total}/20 below coaching threshold` };
  if (isLost(g) && Number(call.duration_sec) > LOST_LEAD_MIN_SEC) return { code: "LOST_LEAD", reason: `High-intent lead lost after ${Math.round(call.duration_sec / 60)} min` };
  return null;
}

/** Above the cap in the trailing hour, the alert is suppressed into the digest instead of sent. */
export const suppressed = (sentLastHour) => Number(sentLastHour) >= ALERT_CAP_PER_HOUR;

export function alertText(call, g, trigger) {
  const total = totalScore(g);
  return `[QA Alert ${call.store_code || "STOREA"}]\nRep: ${call.rep_name || "Unknown"} | Score: ${total}/20\nTrigger: ${trigger.reason}\nCoaching: ${g.coaching_note}\nSession: ${call.telephony_session_id}`.slice(0, 900);
}
