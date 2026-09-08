//! The contract must prove it can FAIL: every gate below is exercised from the refusing side
//! before the allowing side is trusted. The worked points come from ../detents.tsv, the same
//! file the JS twin reads, so the panel, the Rust and the JS cannot drift apart silently.
use wosp_apex_contract::*;

fn fixture() -> Vec<(u8, f32, f32, bool, String, bool)> {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/detents.tsv")).expect("detents.tsv beside Cargo.toml");
    raw.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| {
        let f: Vec<&str> = l.split('\t').collect();
        (f[0].parse().unwrap(), f[1].parse().unwrap(), f[2].parse().unwrap(), f[3] == "true", f[4].to_string(), f[5] == "true")
    }).collect()
}

#[test]
fn dial_matches_the_worked_points() {
    let rows = fixture(); assert!(rows.len() >= 12, "fixture is thin");
    for (d, conf, budget, write, detent, prod) in rows {
        let dial = PrecisionDialConfig::new(d as u16).unwrap();
        assert!((dial.confidence_threshold() - conf).abs() < 1e-3, "conf at {d}");
        assert!((dial.max_compute_budget_usd() - budget).abs() < 0.02, "budget at {d}: {} vs {budget}", dial.max_compute_budget_usd());
        assert_eq!(dial.write_clearance(), write, "write at {d}");
        assert_eq!(dial.detent().name(), detent, "detent at {d}");
        assert_eq!(dial.prod_write_clearance(), prod, "prod write at {d}");
    }
}

#[test]
fn dial_refuses_out_of_range_and_names_the_50_cliff() {
    assert_eq!(PrecisionDialConfig::new(101), Err(ApexError::DialOutOfRange(101)));
    let at50 = PrecisionDialConfig::new(50).unwrap();
    assert!(at50.write_clearance() && !at50.prod_write_clearance(), "50: write bit on, still SHADOW");
    assert_eq!(at50.detent(), Detent::Shadow);
    assert!(PrecisionDialConfig::new(51).unwrap().prod_write_clearance());
    // derate is allowed, raise is not representable
    let d65 = PrecisionDialConfig::new(65).unwrap();
    assert_eq!(d65.derated(40).dial_position, 40);
    assert_eq!(d65.derated(90).dial_position, 65, "a department cannot run above the apex dial");
}

#[test]
fn dual_gate_writes_are_and_not_synonyms() {
    let w = Wetware::at_the_panel();
    let mut sb = Switchboard::standard();
    let d90 = PrecisionDialConfig::new(90).unwrap();
    let d40 = PrecisionDialConfig::new(40).unwrap();
    let d65 = PrecisionDialConfig::new(65).unwrap();
    // Toggle OFF + dial 90 → dark circuit
    assert_eq!(may_write(&d90, &sb, WriteTarget::Mock), Err(Stop::DarkCircuit("write_ops".into())));
    // Toggle ON + dial 40 → dial cliff
    sb.set(w, "write_ops", Toggle::On).unwrap();
    assert_eq!(may_write(&d40, &sb, WriteTarget::Mock), Err(Stop::DialCliff { need: 50, have: 40 }));
    // both → guarded write legal (mock)
    assert_eq!(may_write(&d65, &sb, WriteTarget::Mock), Ok(()));
    // prod needs the prod circuit too
    assert_eq!(may_write(&d65, &sb, WriteTarget::Prod), Err(Stop::ProdCircuitDark));
    sb.set(w, "prod", Toggle::On).unwrap();
    assert_eq!(may_write(&d65, &sb, WriteTarget::Prod), Ok(()));
    // at exactly 50 with prod ON: mock yes, prod no — SHADOW writes only to mock trees
    let d50 = PrecisionDialConfig::new(50).unwrap();
    assert_eq!(may_write(&d50, &sb, WriteTarget::Mock), Ok(()));
    assert_eq!(may_write(&d50, &sb, WriteTarget::Prod), Err(Stop::ProdBelowAssisted { have: 50 }));
}

#[test]
fn platform_surface_circuits_exist_off_and_guarded() {
    // The six Wayne.com surfaces are circuits on the standard board: present, OFF, muted,
    // flip-covered. Arming one is a wetware act; a missing one would let a "read-only" seat
    // hold a shell it never declared.
    let sb = Switchboard::standard();
    assert_eq!(sb.circuits.len(), STANDARD_CIRCUITS.len());
    for id in PLATFORM_SURFACES {
        let c = sb.circuits.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("surface circuit {id} missing"));
        assert_eq!(c.toggle, Toggle::Off, "{id} must be declared OFF");
        assert_eq!(c.lamp, Lamp::Muted, "{id} lamp must start muted");
        assert!(c.guarded, "{id} exposes or executes and must carry a flip-cover");
        assert!(!sb.allows(id), "{id} must not exist this epoch until a hand arms it");
    }
    // the pre-existing gates still stop first: a dark write_ops outranks an armed surface
    let w = Wetware::at_the_panel();
    let mut sb2 = Switchboard::standard();
    sb2.set(w, "shell", Toggle::On).unwrap();
    assert!(sb2.allows("shell"));
    assert_eq!(may_write(&PrecisionDialConfig::new(90).unwrap(), &sb2, WriteTarget::Mock), Err(Stop::DarkCircuit("write_ops".into())));
}

#[test]
fn gate_step_stops_in_order_circuit_radius_budget_time() {
    let w = Wetware::at_the_panel();
    let mut sb = Switchboard::standard();
    let dial = PrecisionDialConfig::new(65).unwrap();
    let step = Step { tool: "github".into(), requires_write: Some(WriteTarget::Mock), estimated_usd: 3.0 };
    assert_eq!(gate_step(&step, &dial, &sb, 100.0, 60), Err(Stop::DarkCircuit("github".into())));
    sb.set(w, "github", Toggle::On).unwrap();
    assert_eq!(gate_step(&step, &dial, &sb, 100.0, 60), Err(Stop::DarkCircuit("write_ops".into())));
    sb.set(w, "write_ops", Toggle::On).unwrap();
    assert_eq!(gate_step(&step, &dial, &sb, 2.0, 60), Err(Stop::BudgetCliff { need_usd: 3.0, remaining_usd: 2.0 }));
    assert_eq!(gate_step(&step, &dial, &sb, 100.0, 0), Err(Stop::EpochClaw));
    assert_eq!(gate_step(&step, &dial, &sb, 100.0, 60), Ok(()));
}

#[test]
fn lamps_are_readouts_and_tripped_is_not_off() {
    let w = Wetware::at_the_panel();
    let mut sb = Switchboard::standard();
    assert_eq!(sb.trip("gmail"), Ok(()), "tripping an OFF circuit is a no-op, not an error");
    assert!(!sb.allows("gmail"));
    sb.set(w, "gmail", Toggle::On).unwrap();
    sb.trip("gmail").unwrap();
    assert!(sb.allows("gmail"), "red lamp + green toggle is a legal state: the circuit is live");
    assert_eq!(sb.tripped(), vec!["gmail".to_string()]);
    sb.reset(w, "gmail").unwrap();
    assert!(sb.tripped().is_empty());
    assert_eq!(sb.set(w, "nope", Toggle::On), Err(ApexError::UnknownCircuit("nope".into())));
    assert_eq!(sb.mask(), vec!["gmail".to_string()]);
}

#[test]
fn chronometer_pins_strobe_and_the_claw_fires() {
    let w = Wetware::at_the_panel();
    let mut t = PinTimer::new();
    assert_eq!(t.pins.len(), PIN_COUNT);
    assert_eq!(t.set_pin(w, 7, true, "x", 60), Err(ApexError::PinOffGrid(7)));
    assert_eq!(t.set_pin(w, 120, true, "  ", 60), Err(ApexError::PinNeedsInscription(120)));
    assert_eq!(t.set_pin(w, 120, true, "audit comm signals & repo", 2), Err(ApexError::EpochTooShort(2)));
    assert_eq!(t.next_strobe(0), None, "nothing armed: sleep");
    t.set_pin(w, 120, true, "audit comm signals & repo", 60).unwrap();   // 02:00
    t.set_pin(w, 1380, true, "nightly reconcile", 240).unwrap();          // 23:00
    let (pin, wait) = t.next_strobe(60).unwrap(); assert_eq!((pin.tick_min, wait), (120, 60));
    let (pin, wait) = t.next_strobe(1400).unwrap(); assert_eq!((pin.tick_min, wait), (120, 160), "wraps midnight");
    let (pin, wait) = t.next_strobe(120).unwrap(); assert_eq!((pin.tick_min, wait), (120, 0), "on the tick strobes now");
    let p = t.pins[8].clone();
    assert_eq!(PinTimer::epoch_remaining(&p, 120, 150), 30);
    assert!(PinTimer::epoch_expired(&p, 120, 180), "at the gear-train limit the claw fires");
    assert!(!PinTimer::epoch_expired(&p, 120, 179));
    t.set_gears(w, false);
    assert_eq!(t.next_strobe(60), None, "gears off: nothing strobes, pins stay on the rim");
    assert_eq!(t.pins_out().len(), 2);
}

#[test]
fn armed_states_read_off_the_three_instruments() {
    let w = Wetware::at_the_panel();
    let mut t = PinTimer::new(); let mut sb = Switchboard::standard();
    let d0 = PrecisionDialConfig::new(0).unwrap();
    t.set_gears(w, false);
    assert_eq!(armed_state(&t, &d0, &sb, false), ArmedState::AirGap);
    t.set_gears(w, true);
    t.set_pin(w, 120, true, "sweep", 240).unwrap();
    sb.set(w, "github", Toggle::On).unwrap(); sb.set(w, "cdn", Toggle::On).unwrap();
    let d65 = PrecisionDialConfig::new(65).unwrap();
    assert_eq!(armed_state(&t, &d65, &sb, false), ArmedState::ArmedSleep, "policy and circuits live, no token burn");
    assert_eq!(armed_state(&t, &d65, &sb, true), ArmedState::GuardedEpoch);
    let d15 = PrecisionDialConfig::new(15).unwrap();
    assert_eq!(armed_state(&t, &d15, &sb, true), ArmedState::Sentinel);
    sb.set(w, "prod", Toggle::On).unwrap();
    let d90 = PrecisionDialConfig::new(90).unwrap();
    assert_eq!(armed_state(&t, &d90, &sb, true), ArmedState::Hotfix, "legal only because wetware set both radius and circuit");
    let d100 = PrecisionDialConfig::new(100).unwrap();
    assert_eq!(armed_state(&t, &d100, &sb, true), ArmedState::Unchecked);
}
