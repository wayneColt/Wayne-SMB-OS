// diagnostic_recall.js — "what did we do the last time we saw this, and did the car come back?"
//
// Retrieval over the shop's OWN completed repair orders. Deliberately NOT a diagnosis: it returns
// prior work, never a cause. A retrieved answer is checkable against a repair order the
// technician can open; a generated one is not. No model. Stateless: the caller supplies rows and
// the module holds nothing. Relevance is IDF-weighted over the rows supplied, so it is relative to
// this shop's own history, not to any outside corpus. Derived 2026-09-09 from the deployed bay
// organ (composed 2026-08-06, byte-verified live 2026-08-10, 50-assertion suite 2026-08-16).
//
// Rung 0: no standard, no run. The buyer's rubric names the field map, the stop words, the
// comeback definition and the redaction rules; without a standard name the module refuses.

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const PHONE_RE = /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g;

/** Last gate before the wire: every free-text field echoed back is scrubbed of VIN, email, phone. */
export function scrub(s) {
  if (typeof s !== "string") return s;
  return s.replace(VIN_RE, "[VIN]").replace(EMAIL_RE, "[EMAIL]").replace(PHONE_RE, "[PHONE]");
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "on", "in", "is", "was",
  "with", "at", "by", "it", "this", "that", "job", "customer", "vehicle", "please"]);

export function terms(s, extraStop = []) {
  const stop = extraStop.length ? new Set([...STOP, ...extraStop.map((x) => String(x).toLowerCase())]) : STOP;
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !stop.has(t));
}

/** Flatten supplied ROs to job-level documents. Accepts the flat snake_case contract shape or camelCase. */
export function jobDocs(rows) {
  const docs = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const jobs = Array.isArray(r?.jobs) ? r.jobs : [];
    for (const j of jobs) {
      docs.push({
        ro: r.repair_order_number ?? r.repairOrderNumber ?? r.ro_number ?? null,
        vehicle: r.vehicle_id ?? r.vehicleId ?? null,
        tech: j.technician_id ?? j.technicianId ?? r.technician_id ?? r.technicianId ?? null,
        completed: r.completed_date ?? r.completedDate ?? r.postedDate ?? null,
        miles: r.miles_in ?? r.milesIn ?? null,
        name: j.name ?? null,
        category: j.category ?? j.jobCategoryName ?? null,
        note: j.note ?? null,
        hours: Number(j.labor_hours ?? j.laborHours ?? 0) || 0,
        labor: Number(j.labor_total ?? j.laborTotal ?? 0) || 0,
        parts: Number(j.parts_total ?? j.partsTotal ?? 0) || 0,
      });
    }
  }
  return docs;
}

const KIND = "bay_diagnostic_recall";
const noSignal = (reason, ask, standard) => ({
  kind: KIND, standard: standard ?? null, membrane: "NO_SIGNAL", reason, ask, fabricated: false,
});

export function diagnosticRecall(args) {
  const standard = args?.standard ? String(args.standard) : null;
  if (!standard)
    return noSignal("no standard supplied — no standard, no run (Rung 0)",
      { question: "which rubric is this question answered under? name it", who: "the buyer",
        unlocks: "retrieval over this shop's own repair history" }, null);
  const q = String(args?.query || "").trim();
  const docs = jobDocs(args?.rows);
  const limit = Math.max(1, Math.min(Number(args?.limit) || 8, 50));
  const extraStop = Array.isArray(args?.stop_words) ? args.stop_words : [];

  if (!q)
    return noSignal("no query supplied",
      { question: "what is the complaint, symptom or system to look up?", who: "technician",
        unlocks: "retrieval over this shop's own repair history" }, standard);
  if (docs.length === 0)
    return noSignal("no repair-order rows supplied — the module is stateless and holds no shop data",
      { question: "supply completed repair orders (rows[]) for the period to search",
        who: "the calling node", unlocks: "diagnostic recall" }, standard);

  const qt = terms(q, extraStop);
  if (qt.length === 0)
    return noSignal(`query "${q}" reduced to zero searchable terms after stop-word removal`,
      { question: "use a symptom or system word, e.g. 'misfire under load' or 'brake pulsation'",
        who: "technician", unlocks: "diagnostic recall" }, standard);

  // IDF over the supplied corpus — a term that appears in every job carries no information.
  const df = new Map();
  const docTerms = docs.map((d) => {
    const t = new Set([...terms(d.name, extraStop), ...terms(d.category, extraStop), ...terms(d.note, extraStop)]);
    for (const x of t) df.set(x, (df.get(x) || 0) + 1);
    return t;
  });
  const N = docs.length;

  const scored = [];
  for (let i = 0; i < docs.length; i++) {
    let s = 0, hit = 0;
    for (const t of qt) {
      if (!docTerms[i].has(t)) continue;
      hit += 1;
      s += Math.log(1 + N / (1 + (df.get(t) || 0)));
    }
    if (hit > 0) scored.push({ i, score: Number(s.toFixed(4)), matched: hit });
  }
  scored.sort((a, b) => b.score - a.score || b.matched - a.matched);

  // Which of these vehicles came back at all — the single most useful fact a technician can
  // have about a prior repair, and it is free from the same rows.
  const visits = new Map();
  for (const d of docs) {
    if (d.vehicle == null || !d.completed) continue;
    if (!visits.has(d.vehicle)) visits.set(d.vehicle, new Set());
    visits.get(d.vehicle).add(String(d.completed).slice(0, 10));
  }

  const hits = scored.slice(0, limit).map(({ i, score, matched }) => {
    const d = docs[i];
    const days = d.vehicle != null ? (visits.get(d.vehicle) || new Set()).size : 0;
    return {
      score, terms_matched: matched, repair_order: d.ro,
      job: scrub(d.name), category: d.category, note: scrub(d.note),
      flag_hours: d.hours, labor: d.labor, parts: d.parts,
      technician_id: d.tech, completed: d.completed, miles_in: d.miles,
      vehicle_return_visits: days,
      vehicle_returned: days > 1,
    };
  });

  const out = {
    kind: KIND, standard,
    query: q, query_terms: qt,
    corpus_jobs: N, corpus_repair_orders: new Set(docs.map((d) => d.ro)).size,
    matches_found: scored.length, returned: hits.length,
    hits,
    membrane: hits.length ? "VERIFIED" : "NO_SIGNAL",
    reason: hits.length
      ? "retrieved from the repair orders supplied — every hit is a repair order the technician can open"
      : `no job in the ${N} supplied matched any of: ${qt.join(", ")}`,
    proves: "what this shop has actually done about this complaint before, and whether it held",
    blind: "it retrieves prior work; it does NOT diagnose. It cannot know whether a past repair "
         + "was correct — only that it was performed and whether the vehicle came back.",
    law: "retrieval over your own history, not generation. Every hit is checkable against a repair order.",
    fabricated: false,
  };
  if (!hits.length) out.ask = { question: "try a different symptom word, or widen the period supplied",
    who: "technician", unlocks: "diagnostic recall" };
  return out;
}

/**
 * comebackWatch — the label that costs nothing: same vehicle, same category, back inside N days.
 * Returns pairs to READ and refuses to score risk below n=300. Reports right-censoring honestly:
 * a window longer than the observed span cannot be measured.
 */
export function comebackWatch(args) {
  const win = Math.max(1, Math.min(Number(args?.window_days) || 30, 365));
  const docs = jobDocs(args?.rows).filter((d) => d.vehicle != null && d.completed);
  if (docs.length === 0)
    return { kind: "bay_comeback_watch", membrane: "NO_SIGNAL",
      reason: "no rows with both a vehicle id and a completion date were supplied",
      ask: { question: "supply completed repair orders carrying vehicle_id and completed_date",
             who: "the calling node", unlocks: "the comeback label" }, fabricated: false };
  const byVehicle = new Map();
  for (const d of docs) { if (!byVehicle.has(d.vehicle)) byVehicle.set(d.vehicle, []); byVehicle.get(d.vehicle).push(d); }
  const pairs = [];
  for (const [veh, list] of byVehicle) {
    list.sort((a, b) => String(a.completed).localeCompare(String(b.completed)));
    for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) {
      if (list[i].ro === list[k].ro) continue;
      const t0 = Date.parse(list[i].completed), t1 = Date.parse(list[k].completed);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      const days = (t1 - t0) / 86400000;
      if (days <= 0 || days > win) continue;
      if (!(list[i].category && list[i].category === list[k].category)) continue;
      pairs.push({ vehicle_ref: `veh#${String(veh).slice(-4)}`, category: list[i].category,
        first_ro: list[i].ro, return_ro: list[k].ro, days_between: Math.round(days),
        first_tech: list[i].tech, return_tech: list[k].tech,
        first_flag_hours: list[i].hours, return_flag_hours: list[k].hours });
    }
  }
  const eligible = new Set(docs.map((d) => d.ro)).size;
  const byCat = {}; for (const p of pairs) byCat[p.category] = (byCat[p.category] || 0) + 1;
  const stamps = docs.map((d) => Date.parse(d.completed)).filter(Number.isFinite);
  const spanDays = stamps.length ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 86400000) : 0;
  const newest = stamps.length ? Math.max(...stamps) : null;
  const fullyObserved = stamps.filter((t) => newest !== null && (newest - t) / 86400000 >= win).length;
  const censored = win > spanDays || fullyObserved === 0;
  const SUFFICIENT_FOR_CLASSIFIER = 300;
  return {
    kind: "bay_comeback_watch", window_days: win, repair_orders_considered: eligible,
    vehicles_with_multiple_visits: [...byVehicle.values()].filter((l) => new Set(l.map((d) => d.ro)).size > 1).length,
    labelled_pairs: pairs.length, by_category: byCat, pairs: pairs.slice(0, 40),
    observation_span_days: spanDays, repair_orders_fully_observed: fullyObserved, right_censored: censored,
    membrane: censored ? "NO_SIGNAL" : "VERIFIED",
    reason: censored
      ? `a ${win}-day comeback window cannot be measured over a ${spanDays}-day corpus — ${fullyObserved} of ${eligible} repair orders have had a full ${win} days to come back. Any count here is right-censoring, not a comeback rate.`
      : `${pairs.length} same-vehicle same-category returns within ${win} days, measured from ${eligible} repair orders`,
    sufficient_for_classifier: !censored && pairs.length >= SUFFICIENT_FOR_CLASSIFIER,
    classifier_note: pairs.length >= SUFFICIENT_FOR_CLASSIFIER
      ? `n=${pairs.length} may support a comeback-risk model; validate on a held-out period before trusting it`
      : `n=${pairs.length} is below ${SUFFICIENT_FOR_CLASSIFIER} — READ these pairs, do not fit a model to them.`,
    proves: "which vehicles came back for the same system inside the window, and how fast",
    blind: "a return is not proof the first repair was wrong — the same system can fail twice, and a customer can decline the fix that would have prevented it.",
    law: "the label is free and needs no annotation; the inference it licenses is bounded by n",
    fabricated: false,
  };
}
