/**
 * apex.js — the JS twin of apex/contract (Rust). Same math, same cliffs, same fixture.
 * The Worker enforces the dual gate with this; the Face renders from it. If this file and
 * the Rust crate ever disagree, test/apex.test.js and tests/contract.rs both go red on the
 * same detents.tsv rows. fabricated:false
 */
export const DETENTS = Object.freeze([
  { name: "MONITOR",    lo: 0,   hi: 25,  posture: "read MCP, diff, report" },
  { name: "SHADOW",     lo: 26,  hi: 50,  posture: "real network, mock commits" },
  { name: "ASSISTED",   lo: 51,  hi: 75,  posture: "IPC writes under threshold" },
  { name: "AUTONOMOUS", lo: 76,  hi: 99,  posture: "multi-day, key rotate, heal hooks" },
  { name: "UNCHECKED",  lo: 100, hi: 100, posture: "kernel/sandbox is the only wall" },
]);
export const DETENT_RANK = Object.freeze({ MONITOR: 0, SHADOW: 1, ASSISTED: 2, AUTONOMOUS: 3, UNCHECKED: 4 });
export const RING_MINUTES = 24 * 60, PIN_STEP = 15, PIN_COUNT = RING_MINUTES / PIN_STEP, MIN_EPOCH = 5, DEFAULT_EPOCH = 240;
export const STANDARD_CIRCUITS = Object.freeze([
  ["gmail", false], ["github", false], ["cdn", false], ["r2", false], ["d1", false],
  ["ringcentral", false], ["workers_ai", true], ["babel", true], ["write_ops", true], ["prod", true],
  // Wayne.com surfaces (inventory 2026-09-06): each exposes or executes, so each is flip-covered.
  // Declared OFF; arming one is a wetware act. `comms` reaches the LAN through the pre-existing ucc tunnel.
  ["comms", true], ["shell", true], ["container", true], ["chat", true], ["canvas", true], ["task", true],
]);
export const PLATFORM_SURFACES = Object.freeze(["comms", "shell", "container", "chat", "canvas", "task"]);

export function detentOf(d) { for (const t of DETENTS) if (d >= t.lo && d <= t.hi) return t.name; throw new RangeError(`dial ${d} off the scale`); }
export function dial(d) {
  d = Number(d);
  if (!Number.isInteger(d) || d < 0 || d > 100) throw new RangeError(`dial ${d} out of range 0..100`);
  const detent = detentOf(d);
  return Object.freeze({
    position: d, detent,
    confidence: 0.99 - 0.0039 * d,
    budget_usd: 0.05 * Math.pow(d, 1.8),
    write: d >= 50,
    prod_write: DETENT_RANK[detent] >= DETENT_RANK.ASSISTED,
  });
}
export const derated = (apex, departmentMax) => dial(Math.min(apex.position, departmentMax));

export function chronometer(state) {
  const pins = Array.isArray(state && state.pins) && state.pins.length === PIN_COUNT ? state.pins : Array.from({ length: PIN_COUNT }, (_, i) => ({ tick: i * PIN_STEP, out: false, inscription: "", epoch: DEFAULT_EPOCH }));
  return { pins, gears: state && typeof state.gears === "boolean" ? state.gears : true };
}
export function setPin(chrono, tick, out, inscription, epoch = DEFAULT_EPOCH) {
  if (!Number.isInteger(tick) || tick < 0 || tick >= RING_MINUTES || tick % PIN_STEP !== 0) throw new RangeError(`pin ${tick} off the 15-minute grid`);
  if (out && !String(inscription || "").trim()) throw new RangeError(`pin ${tick} pulled out needs an inscription`);
  if (!Number.isInteger(epoch) || epoch < MIN_EPOCH) throw new RangeError(`epoch ${epoch} shorter than ${MIN_EPOCH} min`);
  const pins = chrono.pins.slice(); pins[tick / PIN_STEP] = { tick, out: !!out, inscription: out ? String(inscription).trim() : "", epoch };
  return { ...chrono, pins };
}
export const pinsOut = (chrono) => chrono.pins.filter((p) => p.out);
export function nextStrobe(chrono, nowMin) {
  if (!chrono.gears) return null;
  const now = ((nowMin % RING_MINUTES) + RING_MINUTES) % RING_MINUTES;
  let best = null;
  for (const p of chrono.pins) { if (!p.out) continue; const wait = (p.tick + RING_MINUTES - now) % RING_MINUTES; if (!best || wait < best.wait) best = { pin: p, wait }; }
  return best;
}
export function epochRemaining(pin, strobeMin, nowMin) { const elapsed = (nowMin + RING_MINUTES - strobeMin) % RING_MINUTES; return Math.max(0, pin.epoch - elapsed); }

export function switchboard(state) {
  const known = new Map(STANDARD_CIRCUITS.map(([id, guarded]) => [id, { id, toggle: "OFF", lamp: "MUTED", guarded }]));
  for (const c of (state && state.circuits) || []) if (known.has(c.id)) known.set(c.id, { ...known.get(c.id), toggle: c.toggle === "ON" ? "ON" : "OFF", lamp: ["OK", "TRIPPED", "MUTED"].includes(c.lamp) ? c.lamp : "MUTED" });
  return { circuits: [...known.values()] };
}
export const allows = (sb, id) => sb.circuits.some((c) => c.id === id && c.toggle === "ON");
export function setToggle(sb, id, on) {
  if (!sb.circuits.some((c) => c.id === id)) throw new RangeError(`unknown circuit ${id}`);
  return { circuits: sb.circuits.map((c) => c.id !== id ? c : { ...c, toggle: on ? "ON" : "OFF", lamp: on ? (c.lamp === "MUTED" ? "OK" : c.lamp) : "MUTED" }) };
}
/** a worker trips a lamp: state, not policy — the toggle does not move */
export const trip = (sb, id) => ({ circuits: sb.circuits.map((c) => c.id === id && c.toggle === "ON" ? { ...c, lamp: "TRIPPED" } : c) });
export const reset = (sb, id) => ({ circuits: sb.circuits.map((c) => c.id === id && c.toggle === "ON" ? { ...c, lamp: "OK" } : c) });
export const mask = (sb) => sb.circuits.filter((c) => c.toggle === "ON").map((c) => c.id);
export const tripped = (sb) => sb.circuits.filter((c) => c.lamp === "TRIPPED").map((c) => c.id);
export const allOff = (sb) => sb.circuits.every((c) => c.toggle === "OFF");

/** Write Ops toggle AND dial write bit; prod adds the prod toggle AND ASSISTED+. Returns null (ok) or the stop. */
export function mayWrite(dl, sb, target = "mock") {
  if (!allows(sb, "write_ops")) return { stop: "DARK_CIRCUIT", circuit: "write_ops" };
  if (!dl.write) return { stop: "DIAL_CLIFF", need: 50, have: dl.position };
  if (target === "prod") {
    if (!allows(sb, "prod")) return { stop: "PROD_CIRCUIT_DARK" };
    if (!dl.prod_write) return { stop: "PROD_BELOW_ASSISTED", have: dl.position };
  }
  return null;
}
/** circuit → radius → budget → time. Escalate, never widen. */
export function gateStep(step, dl, sb, remainingUsd, remainingEpochMin) {
  if (!allows(sb, step.tool)) return { stop: "DARK_CIRCUIT", circuit: step.tool };
  if (step.write) { const s = mayWrite(dl, sb, step.write); if (s) return s; }
  if (Number(step.usd || 0) > remainingUsd) return { stop: "BUDGET_CLIFF", need_usd: Number(step.usd), remaining_usd: remainingUsd };
  if (remainingEpochMin <= 0) return { stop: "EPOCH_CLAW" };
  return null;
}
export function armedState(chrono, dl, sb, strobing) {
  const d = dl.position;
  if (!chrono.gears && allOff(sb) && d === 0) return "AIR-GAP";
  if (d === 100 && !allOff(sb)) return "UNCHECKED";
  if (!strobing && pinsOut(chrono).length) return "ARMED SLEEP";
  if (strobing && d >= 85 && d <= 95 && allows(sb, "prod")) return "HOTFIX";
  if (strobing && d >= 10 && d <= 25 && !allows(sb, "prod")) return "SENTINEL";
  if (strobing && d >= 51 && d <= 75) return "GUARDED EPOCH";
  return "CUSTOM";
}
