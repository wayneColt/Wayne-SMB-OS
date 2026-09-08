// disp-qube must prove the contracts: base64 to turbo, json_schema to the fp8-fast model, and a
// schema-miss error surfaces as NO_SIGNAL rather than a JSON.parse crash. fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { WHISPER, LLM, SCHEMA, transcribe, grade } from "../src/index.js";

function ai(reply) { const calls = []; return { calls, AI: { async run(model, input) { calls.push({ model, input }); return typeof reply === "function" ? reply(model, input) : reply; } } }; }
const req = (path, init) => new Request("https://rc-qa-infer.internal" + path, init);

test("transcribe sends BASE64 audio to whisper-large-v3-turbo with language en", async () => {
  const { calls, AI } = ai({ text: "hello shop" });
  const bytes = new Uint8Array([1, 2, 3, 250, 251]);
  const r = await transcribe({ AI }, bytes.buffer);
  assert.equal(r.text, "hello shop"); assert.equal(r.model, WHISPER); assert.equal(r.bytes, 5);
  assert.equal(calls[0].model, WHISPER); assert.equal(typeof calls[0].input.audio, "string"); assert.equal(calls[0].input.audio, Buffer.from(bytes).toString("base64")); assert.equal(calls[0].input.language, "en");
  assert.ok(!Array.isArray(calls[0].input.audio), "the bytes-array contract belongs to @cf/openai/whisper, not turbo");
});

test("grade drives llama-3.3-70b-instruct-fp8-fast with a json_schema and never returns a model-reported total", async () => {
  const obs = { greeting_score: 4, discovery_score: 3, action_score: 4, empathy_score: 5, qualified: true, intake_outcome: "Scheduled", service_type: "brakes", hostility_flag: false, strengths: "s", coaching_note: "c", total_score: 99 };
  const { calls, AI } = ai({ response: obs });
  const r = await grade({ AI }, "Thanks for calling the shop Store A…");
  assert.equal(r.model, LLM); assert.equal(r.rubric_version, "client-rubric-example+wayne-smb-v1"); assert.equal("total_score" in r.observations, false); assert.equal(r.observations.empathy_score, 5);
  assert.equal(calls[0].input.response_format.type, "json_schema"); assert.deepEqual(calls[0].input.response_format.json_schema, SCHEMA);
  assert.ok(!("total_score" in SCHEMA.properties), "the schema does not ask for a sum");
  assert.ok(!("call_outcome" in SCHEMA.properties), "call_outcome is derived by policy, never asked");
  assert.deepEqual(SCHEMA.properties.intake_outcome.enum, ["Scheduled", "Will Call Back", "Pricing Concerns", "No Next Steps", "Not Qualified", "Complaint"]);
  const { SYSTEM } = await import("../src/index.js"); assert.match(SYSTEM, /A lead is considered "Scheduled" if the `Intakes` column contains the word "Scheduled"/, "the client rule 1 verbatim"); assert.match(SYSTEM, /Group any blank, NaN, or "-" entries/, "the client rule 4 verbatim"); assert.match(SYSTEM, /Do not estimate dollar values/);
  const { AI: AI2 } = ai({ response: JSON.stringify(obs) }); const r2 = await grade({ AI: AI2 }, "x"); assert.equal(r2.observations.greeting_score, 4, "a string response is parsed");
});

test("CONTROL — a schema miss is an error from Workers AI and comes back as 502 NO_SIGNAL, not a crash", async () => {
  const { AI } = ai(() => { throw new Error("JSON Mode couldn't be met"); });
  const r = await worker.fetch(req("/grade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript: "hi" }) }), { AI });
  assert.equal(r.status, 502); const j = await r.json(); assert.equal(j.membrane, "NO_SIGNAL"); assert.match(j.reason, /JSON Mode/); assert.equal(j.model, LLM);
});

test("routes: health public shape; empty audio 400; oversize 413; empty transcript 400; missing AI binding 503; unknown route 404", async () => {
  const { AI } = ai({ text: "t" });
  const h = await (await worker.fetch(req("/health"), { AI })).json(); assert.equal(h.layer, "disp-qube"); assert.equal(h.routed, false); assert.equal(h.models.grade, LLM); assert.equal(h.rubric_version, "client-rubric-example+wayne-smb-v1");
  assert.equal((await worker.fetch(req("/transcribe", { method: "POST", body: new Uint8Array(0) }), { AI })).status, 400);
  assert.equal((await worker.fetch(req("/transcribe", { method: "POST", headers: { "content-length": String(30 * 1024 * 1024) }, body: new Uint8Array([1]) }), { AI })).status, 413);
  assert.equal((await worker.fetch(req("/grade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript: " " }) }), { AI })).status, 400);
  assert.equal((await worker.fetch(req("/grade", { method: "POST", body: "{}" }), {})).status, 503);
  assert.equal((await worker.fetch(req("/nope"), { AI })).status, 404);
  const ok = await worker.fetch(req("/transcribe", { method: "POST", body: new Uint8Array([9, 9, 9]) }), { AI }); assert.equal(ok.status, 200); assert.equal((await ok.json()).text, "t");
});
