// The gate must prove it can refuse before its allow means anything. fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateObservations, totalScore, evaluateGate, suppressed, alertText, LOW_SCORE_THRESHOLD, ALERT_CAP_PER_HOUR, isScheduled, isLost, callOutcome, staffOf } from "../src/policy.js";
import { redact } from "../src/redact.js";

const good = { greeting_score: 4, discovery_score: 3, action_score: 4, empathy_score: 4, qualified: true, intake_outcome: "Scheduled", service_type: "brakes", hostility_flag: false, strengths: "clear greeting", coaching_note: "Ask what the check-engine light did before quoting." };
const call = { telephony_session_id: "s-1", store_code: "STOREA", rep_name: "Rep", duration_sec: 240 };

test("observations are validated: bad ranges, bad outcome, missing note, a model-reported total all go red", () => {
  assert.deepEqual(validateObservations(good), []);
  assert.match(validateObservations({ ...good, greeting_score: 6 }).join(), /greeting_score/);
  assert.match(validateObservations({ ...good, discovery_score: 2.5 }).join(), /discovery_score/);
  assert.match(validateObservations({ ...good, intake_outcome: "maybe" }).join(), /intake_outcome/);
  assert.match(validateObservations({ ...good, qualified: "yes" }).join(), /qualified/);
  assert.match(validateObservations({ ...good, call_outcome: "booked" }).join(), /must not report call_outcome/);
  assert.match(validateObservations({ ...good, coaching_note: undefined }).join(), /coaching_note/);   // MISSING goes red; an empty note is a valid "nothing to coach" (see below)
  assert.match(validateObservations({ ...good, hostility_flag: "no" }).join(), /hostility_flag/);
  assert.match(validateObservations({ ...good, total_score: 15 }).join(), /must not report total_score/);
  assert.deepEqual(validateObservations(null), ["observations missing"]);
});

test("total is arithmetic in code — the live failure mode (3/4/2/3 written as 11, alert false) cannot happen here", () => {
  const g = { ...good, greeting_score: 3, discovery_score: 4, action_score: 2, empathy_score: 3 };
  assert.equal(totalScore(g), 12);
  assert.equal(evaluateGate(g, call), null, "12 is at the threshold, not below it");
  assert.deepEqual(evaluateGate({ ...g, empathy_score: 2 }, call), { code: "LOW_SCORE", reason: "Score 11/20 below coaching threshold" });
  assert.equal(LOW_SCORE_THRESHOLD, 12);
});

test("escalation wins over score; lost lead needs > 3 minutes from the call log, not the model", () => {
  assert.equal(evaluateGate({ ...good, hostility_flag: true, greeting_score: 5, discovery_score: 5, action_score: 5, empathy_score: 5 }, call).code, "ESCALATION");
  const lostLead = { ...good, intake_outcome: "Will Call Back" };
  assert.deepEqual(evaluateGate(lostLead, { ...call, duration_sec: 240 }), { code: "LOST_LEAD", reason: "High-intent lead lost after 4 min" });
  assert.equal(evaluateGate(lostLead, { ...call, duration_sec: 180 }), null, "exactly 3 minutes does not trigger");
  assert.equal(evaluateGate(lostLead, { ...call, duration_sec: 90 }), null);
  assert.equal(evaluateGate(good, { ...call, duration_sec: 900 }), null, "Scheduled is never a lost lead");
  assert.equal(evaluateGate({ ...good, qualified: false, intake_outcome: "Not Qualified" }, { ...call, duration_sec: 900 }), null, "an unqualified caller is not a lead");
});

test("anti-fatigue cap and the SMS text", () => {
  assert.equal(suppressed(ALERT_CAP_PER_HOUR - 1), false); assert.equal(suppressed(ALERT_CAP_PER_HOUR), true);
  const t = alertText(call, good, { code: "LOW_SCORE", reason: "Score 11/20 below coaching threshold" });
  assert.match(t, /^\[QA Alert STOREA\]/); assert.match(t, /Score: 15\/20/); assert.match(t, /Session: s-1/); assert.ok(t.length <= 900);
});

test("the client rules in code: Scheduled (1), Lost = qualified and not Scheduled (2), Unassigned (4); call_outcome is derived", () => {
  assert.equal(isScheduled(good), true); assert.equal(isLost(good), false); assert.equal(callOutcome(good), "booked");
  const wcb = { ...good, intake_outcome: "Will Call Back" }; assert.equal(isLost(wcb), true); assert.equal(callOutcome(wcb), "lost_lead");
  const complaint = { ...good, intake_outcome: "Complaint" }; assert.equal(isLost(complaint), false, "a complaint is not a lead"); assert.equal(callOutcome(complaint), "complaint");
  const nq = { ...good, qualified: false, intake_outcome: "Not Qualified" }; assert.equal(isLost(nq), false); assert.equal(callOutcome(nq), "inquiry");
  const unq = { ...good, qualified: false, intake_outcome: "Pricing Concerns" }; assert.equal(isLost(unq), false, "rule 2 requires Qualified");
  assert.equal(staffOf(" Joey Dudik "), "Joey Dudik"); assert.equal(staffOf(null), "Unassigned"); assert.equal(staffOf("  "), "Unassigned");
});

test("redaction strips card-shaped digit runs and leaves phone numbers", () => {
  assert.equal(redact("card 4111 1111 1111 1111 please"), "card [REDACTED-PAN] please");
  assert.equal(redact("call me at 254-555-0100"), "call me at 254-555-0100");
  assert.equal(redact(""), "");
});

test("an empty coaching note is a valid observation — nothing to coach is an answer, not a schema miss", () => {
  const g = { greeting_score: 5, discovery_score: 4, action_score: 5, empathy_score: 5, qualified: true, intake_outcome: "Scheduled", service_type: "oil change", hostility_flag: false, coaching_note: "", strengths: "clear" };
  assert.deepEqual(validateObservations(g), []);
  assert.deepEqual(validateObservations({ ...g, coaching_note: 7 }), ["coaching_note must be a string (empty means nothing to coach)"]);
});
