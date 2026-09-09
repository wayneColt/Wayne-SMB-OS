import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticRecall, comebackWatch, scrub, terms } from "./diagnostic_recall.js";
import { ROWS } from "./fixture_rows.js";
const STD = "example-shop-recall-v1";

test("Rung 0: no standard, no run", () => {
  const r = diagnosticRecall({ query: "misfire", rows: ROWS });
  assert.equal(r.membrane, "NO_SIGNAL"); assert.match(r.reason, /Rung 0/); assert.equal(r.standard, null);
});
test("no rows → NO_SIGNAL; the module holds no data", () => {
  const r = diagnosticRecall({ query: "misfire", rows: [], standard: STD });
  assert.equal(r.membrane, "NO_SIGNAL"); assert.match(r.reason, /stateless/);
});
test("empty query and stop-word-only query → NO_SIGNAL", () => {
  assert.equal(diagnosticRecall({ query: "", rows: ROWS, standard: STD }).membrane, "NO_SIGNAL");
  assert.equal(diagnosticRecall({ query: "the and for", rows: ROWS, standard: STD }).membrane, "NO_SIGNAL");
});
test("misfire under load: hits ranked, the returned vehicle is flagged, nothing invented", () => {
  const r = diagnosticRecall({ query: "misfire under load", rows: ROWS, standard: STD });
  assert.equal(r.membrane, "VERIFIED"); assert.equal(r.corpus_jobs, 7); assert.equal(r.corpus_repair_orders, 6);
  assert.ok(r.matches_found >= 3);
  assert.ok(r.hits.every((h) => ["RO-5001", "RO-5017"].includes(h.repair_order)));
  assert.ok(r.hits.every((h) => h.vehicle_returned === true && h.vehicle_return_visits === 2));
  assert.ok(r.hits.every((h) => !("shop_id" in h)));
  assert.equal(r.fabricated, false); assert.equal(r.kind, "bay_diagnostic_recall");
});
test("brake pulsation: one hit, the vehicle did not come back", () => {
  const r = diagnosticRecall({ query: "brake pulsation", rows: ROWS, standard: STD });
  assert.equal(r.returned, 1); assert.equal(r.hits[0].repair_order, "RO-5004"); assert.equal(r.hits[0].vehicle_returned, false);
});
test("IDF: a rare term outranks a common one", () => {
  const r = diagnosticRecall({ query: "injector coil", rows: ROWS, standard: STD });
  assert.equal(r.hits[0].repair_order, "RO-5017"); // injector appears once, coil twice
});
test("PII scrub on every echoed note: VIN, phone, email never leave", () => {
  const r = diagnosticRecall({ query: "coolant leak", rows: ROWS, standard: STD });
  const n = r.hits[0].note;
  assert.ok(n.includes("[VIN]") && n.includes("[PHONE]") && n.includes("[EMAIL]"));
  assert.ok(!/1HGCM|555-010|example\.com/.test(n));
  assert.equal(scrub("plain note"), "plain note");
});
test("limit clamps to 1..50", () => {
  assert.equal(diagnosticRecall({ query: "misfire", rows: ROWS, standard: STD, limit: 0 }).returned, 3);
  assert.equal(diagnosticRecall({ query: "misfire", rows: ROWS, standard: STD, limit: 1 }).returned, 1);
});
test("buyer stop words are honored", () => {
  assert.deepEqual(terms("misfire under load", ["load"]), ["misfire", "under"]);
});
test("comeback_watch: right-censoring is reported, never a rate", () => {
  const r = comebackWatch({ rows: ROWS, window_days: 90 });
  assert.equal(r.right_censored, true); assert.equal(r.membrane, "NO_SIGNAL");
  const s = comebackWatch({ rows: ROWS, window_days: 20 });
  assert.equal(s.labelled_pairs, 1); assert.equal(s.pairs[0].vehicle_ref, "veh#1001"); assert.equal(s.sufficient_for_classifier, false);
});
