// make_golden.mjs <out_dir> — computes the public contract's fixture and golden cases with THIS runner,
// so every expected output in the contract is a measured output, never a hand-written one.
import { writeFileSync, mkdirSync } from "node:fs";
import { diagnosticRecall } from "./diagnostic_recall.js";
import { ROWS } from "./fixture_rows.js";
const out = process.argv[2]; if (!out) { console.error("usage: make_golden.mjs <out_dir>"); process.exit(2); }
const STD = "example-shop-recall-v1";
const cases = [
  ["hit-returned",   { query: "misfire under load", rows: ROWS, standard: STD, limit: 3 }],
  ["hit-held",       { query: "brake pulsation", rows: ROWS, standard: STD }],
  ["scrubbed-note",  { query: "coolant leak", rows: ROWS, standard: STD }],
  ["no-standard",    { query: "misfire", rows: ROWS }],
  ["no-rows",        { query: "misfire", rows: [], standard: STD }],
  ["stopwords-only", { query: "the and for", rows: ROWS, standard: STD }],
  ["no-match",       { query: "transmission slip", rows: ROWS, standard: STD }],
];
mkdirSync(`${out}/fixtures`, { recursive: true }); mkdirSync(`${out}/eval`, { recursive: true });
const lines = cases.map(([c, i]) => JSON.stringify({ case: c, in: i, out: diagnosticRecall(i) }));
writeFileSync(`${out}/eval/golden.jsonl`, lines.join("\n") + "\n");
writeFileSync(`${out}/fixtures/mock_query.json`, JSON.stringify({ in: cases[0][1], out: diagnosticRecall(cases[0][1]) }, null, 2) + "\n");
console.log(`wrote ${cases.length} golden cases + mock fixture to ${out}`);
