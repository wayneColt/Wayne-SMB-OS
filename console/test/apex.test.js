// apex.js against the SAME detents.tsv the Rust crate reads. If the twins drift, both go red.
// Then the dual gate, the stops in order, lamps-as-readouts, the ring, and the armed states.
// fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dial, derated, chronometer, setPin, pinsOut, nextStrobe, epochRemaining, switchboard, setToggle, trip, reset, allows, mask, tripped, mayWrite, gateStep, armedState, PIN_COUNT, PLATFORM_SURFACES, STANDARD_CIRCUITS } from "../src/apex.js";

const here = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(join(here, "..", "..", "apex", "contract", "detents.tsv"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));

test("the dial matches the worked points in detents.tsv (the Rust crate reads the same rows)", () => {
  assert.ok(rows.length >= 12);
  for (const [d, conf, budget, write, detent, prod] of rows) {
    const x = dial(Number(d));
    assert.ok(Math.abs(x.confidence - Number(conf)) < 1e-3, `conf at ${d}`);
    assert.ok(Math.abs(x.budget_usd - Number(budget)) < 0.02, `budget at ${d}`);
    assert.equal(x.write, write === "true", `write at ${d}`); assert.equal(x.detent, detent, `detent at ${d}`); assert.equal(x.prod_write, prod === "true", `prod at ${d}`);
  }
  assert.throws(() => dial(101), RangeError); assert.throws(() => dial(-1), RangeError); assert.throws(() => dial(50.5), RangeError);
  assert.equal(derated(dial(65), 40).position, 40); assert.equal(derated(dial(65), 90).position, 65, "no per-department raise");
});

test("dual gate — Toggle OFF + 90 is dark; ON + 40 is a cliff; both is legal; prod needs its own circuit and ASSISTED", () => {
  let sb = switchboard();
  assert.deepEqual(mayWrite(dial(90), sb, "mock"), { stop: "DARK_CIRCUIT", circuit: "write_ops" });
  sb = setToggle(sb, "write_ops", true);
  assert.deepEqual(mayWrite(dial(40), sb, "mock"), { stop: "DIAL_CLIFF", need: 50, have: 40 });
  assert.equal(mayWrite(dial(65), sb, "mock"), null);
  assert.deepEqual(mayWrite(dial(65), sb, "prod"), { stop: "PROD_CIRCUIT_DARK" });
  sb = setToggle(sb, "prod", true);
  assert.equal(mayWrite(dial(65), sb, "prod"), null);
  assert.equal(mayWrite(dial(50), sb, "mock"), null);
  assert.deepEqual(mayWrite(dial(50), sb, "prod"), { stop: "PROD_BELOW_ASSISTED", have: 50 });
});

test("gateStep stops in order: circuit, radius, budget, time", () => {
  let sb = switchboard(); const dl = dial(65); const step = { tool: "github", write: "mock", usd: 3 };
  assert.equal(gateStep(step, dl, sb, 100, 60).stop, "DARK_CIRCUIT");
  sb = setToggle(sb, "github", true);
  assert.deepEqual(gateStep(step, dl, sb, 100, 60), { stop: "DARK_CIRCUIT", circuit: "write_ops" });
  sb = setToggle(sb, "write_ops", true);
  assert.equal(gateStep(step, dl, sb, 2, 60).stop, "BUDGET_CLIFF");
  assert.equal(gateStep(step, dl, sb, 100, 0).stop, "EPOCH_CLAW");
  assert.equal(gateStep(step, dl, sb, 100, 60), null);
});

test("lamps are readouts: tripped is not off, reset does not move the toggle, unknown circuits refuse", () => {
  let sb = switchboard();
  sb = trip(sb, "gmail"); assert.equal(allows(sb, "gmail"), false); assert.deepEqual(tripped(sb), []);
  sb = setToggle(sb, "gmail", true); sb = trip(sb, "gmail");
  assert.equal(allows(sb, "gmail"), true, "red lamp + green toggle is legal"); assert.deepEqual(tripped(sb), ["gmail"]);
  sb = reset(sb, "gmail"); assert.deepEqual(tripped(sb), []); assert.deepEqual(mask(sb), ["gmail"]);
  assert.throws(() => setToggle(sb, "nope", true), RangeError);
  const rehydrated = switchboard({ circuits: [{ id: "cdn", toggle: "ON", lamp: "TRIPPED" }, { id: "bogus", toggle: "ON" }] });
  assert.equal(allows(rehydrated, "cdn"), true); assert.equal(allows(rehydrated, "bogus"), false, "unknown circuits do not rehydrate");
});

test("the ring: 96 pins, off-grid refused, inscription required, midnight wraps, the claw fires at the epoch", () => {
  let c = chronometer(); assert.equal(c.pins.length, PIN_COUNT);
  assert.throws(() => setPin(c, 7, true, "x", 60), RangeError); assert.throws(() => setPin(c, 120, true, " ", 60), RangeError); assert.throws(() => setPin(c, 120, true, "x", 2), RangeError);
  assert.equal(nextStrobe(c, 0), null);
  c = setPin(c, 120, true, "audit comm signals & repo", 60); c = setPin(c, 1380, true, "nightly reconcile", 240);
  assert.deepEqual([nextStrobe(c, 60).pin.tick, nextStrobe(c, 60).wait], [120, 60]);
  assert.deepEqual([nextStrobe(c, 1400).pin.tick, nextStrobe(c, 1400).wait], [120, 160]);
  assert.equal(nextStrobe(c, 120).wait, 0);
  const p = c.pins[8]; assert.equal(epochRemaining(p, 120, 150), 30); assert.equal(epochRemaining(p, 120, 180), 0);
  assert.equal(nextStrobe({ ...c, gears: false }, 60), null); assert.equal(pinsOut(c).length, 2);
});

test("armed states read off the three instruments", () => {
  let c = chronometer(); let sb = switchboard();
  assert.equal(armedState({ ...c, gears: false }, dial(0), sb, false), "AIR-GAP");
  c = setPin(c, 120, true, "sweep", 240); sb = setToggle(setToggle(sb, "github", true), "cdn", true);
  assert.equal(armedState(c, dial(65), sb, false), "ARMED SLEEP");
  assert.equal(armedState(c, dial(65), sb, true), "GUARDED EPOCH");
  assert.equal(armedState(c, dial(15), sb, true), "SENTINEL");
  sb = setToggle(sb, "prod", true);
  assert.equal(armedState(c, dial(90), sb, true), "HOTFIX");
  assert.equal(armedState(c, dial(100), sb, true), "UNCHECKED");
});

test("Wayne.com surface circuits: present, OFF, guarded; a board saved before they existed rehydrates with them", () => {
  const sb = switchboard(null);
  assert.equal(sb.circuits.length, STANDARD_CIRCUITS.length);
  for (const id of PLATFORM_SURFACES) {
    const c = sb.circuits.find((x) => x.id === id);
    assert.ok(c, `${id} missing`); assert.equal(c.toggle, "OFF"); assert.equal(c.lamp, "MUTED"); assert.equal(c.guarded, true);
    assert.equal(allows(sb, id), false, `${id} must not exist this epoch until a hand arms it`);
  }
  // a persisted ten-circuit board (pre-inventory) comes back with the six present and OFF
  const old = switchboard({ circuits: [{ id: "cdn", toggle: "ON", lamp: "OK" }, { id: "prod", toggle: "ON", lamp: "OK" }] });
  assert.equal(old.circuits.length, 16); assert.deepEqual(mask(old), ["cdn", "prod"]);
  // arming a surface does not open writes: write_ops still gates first
  const armed = setToggle(sb, "shell", true);
  assert.equal(allows(armed, "shell"), true);
  assert.deepEqual(mayWrite(dial(90), armed, "mock"), { stop: "DARK_CIRCUIT", circuit: "write_ops" });
});
