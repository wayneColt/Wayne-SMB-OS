//! wosp-apex-contract — the runtime contract for the three instruments.
//!
//! Law of three instruments: Time (Pin Chronometer), Radius (Silver Precision Dial),
//! Circuit (Toggle Switchboard). The Oracle is the READER of the three, never a fourth.
//! Every mutation of an instrument takes a `Wetware` token: there is no method by which
//! an Oracle or a worker can raise a detent, pull a pin, or close a toggle. Workers may
//! trip a lamp (state), never move a toggle (policy). fabricated:false

/// Proof that a hand, not a model, is on the panel. Constructed only at the operator door.
#[derive(Debug, Clone, Copy)]
pub struct Wetware(());
impl Wetware {
    /// The console mints this after a root session is verified. Nothing else may call it.
    pub fn at_the_panel() -> Wetware { Wetware(()) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApexError {
    DialOutOfRange(u16),
    PinOffGrid(u32),
    PinNeedsInscription(u32),
    EpochTooShort(u32),
    UnknownCircuit(String),
}

// ───────────────────────────── the Silver Precision Dial ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Detent { Monitor, Shadow, Assisted, Autonomous, Unchecked }

impl Detent {
    /// Cliffs at 25 / 50 / 75 / 100. Detents, not suggestions: no soft bump.
    pub fn of(d: u8) -> Detent {
        match d { 0..=25 => Detent::Monitor, 26..=50 => Detent::Shadow, 51..=75 => Detent::Assisted, 76..=99 => Detent::Autonomous, _ => Detent::Unchecked }
    }
    pub fn name(&self) -> &'static str {
        match self { Detent::Monitor => "MONITOR", Detent::Shadow => "SHADOW", Detent::Assisted => "ASSISTED", Detent::Autonomous => "AUTONOMOUS", Detent::Unchecked => "UNCHECKED" }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrecisionDialConfig { pub dial_position: u8 }

impl PrecisionDialConfig {
    pub fn new(d: u16) -> Result<Self, ApexError> { if d > 100 { Err(ApexError::DialOutOfRange(d)) } else { Ok(Self { dial_position: d as u8 }) } }
    /// 0.99 at 0 down to 0.60 at 100.
    pub fn confidence_threshold(&self) -> f32 { 0.99 - (self.dial_position as f32 * 0.0039) }
    /// 0.05 · d^1.8 — ~$16 at 25, ~$57 at 50, ~$118 at 75, ~$199 at 100.
    pub fn max_compute_budget_usd(&self) -> f32 { (self.dial_position as f32).powf(1.8) * 0.05 }
    /// The write bit, verbatim: d ≥ 50.
    pub fn write_clearance(&self) -> bool { self.dial_position >= 50 }
    pub fn detent(&self) -> Detent { Detent::of(self.dial_position) }
    /// The 50 cliff, named: at exactly 50 the write bit is on but the detent is still SHADOW,
    /// so writes may reach only mock state trees and staging buckets. Production writes need
    /// ASSISTED or above (d ≥ 51). A prod commit attempted in SHADOW is a trip-claw, not a retry.
    pub fn prod_write_clearance(&self) -> bool { self.detent() >= Detent::Assisted }
    /// Per-department DERATE is allowed; per-department RAISE is not.
    pub fn derated(&self, department_max: u8) -> PrecisionDialConfig {
        PrecisionDialConfig { dial_position: self.dial_position.min(department_max) }
    }
    pub fn set(&mut self, _w: Wetware, d: u16) -> Result<(), ApexError> { *self = Self::new(d)?; Ok(()) }
}

// ───────────────────────────── the Industrial Pin Chronometer ─────────────────────────

pub const RING_MINUTES: u32 = 24 * 60;
pub const PIN_STEP_MINUTES: u32 = 15;
pub const PIN_COUNT: usize = (RING_MINUTES / PIN_STEP_MINUTES) as usize; // 96 pins on the rim
pub const MIN_EPOCH_MINUTES: u32 = 5;
pub const DEFAULT_EPOCH_MINUTES: u32 = 240;

/// One pin on the rim. `out` = strobe armed at `tick_min`; `inscription` is the goal written
/// on the pin (the Oracle plans under it, it does not invent one); `epoch_min` is the gear
/// train: how long the wake may live before the trip-claw fires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin { pub tick_min: u32, pub out: bool, pub inscription: String, pub epoch_min: u32 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinTimer { pub pins: Vec<Pin>, pub gears_engaged: bool }

impl Default for PinTimer { fn default() -> Self { Self::new() } }

impl PinTimer {
    /// All pins in, gears engaged: armed sleep with nothing inscribed yet.
    pub fn new() -> Self {
        PinTimer { pins: (0..PIN_COUNT).map(|i| Pin { tick_min: i as u32 * PIN_STEP_MINUTES, out: false, inscription: String::new(), epoch_min: DEFAULT_EPOCH_MINUTES }).collect(), gears_engaged: true }
    }
    /// Unscrewing a tripper: slow, explicit, wetware. A pin pulled out must carry an inscription.
    pub fn set_pin(&mut self, _w: Wetware, tick_min: u32, out: bool, inscription: &str, epoch_min: u32) -> Result<(), ApexError> {
        if tick_min >= RING_MINUTES || tick_min % PIN_STEP_MINUTES != 0 { return Err(ApexError::PinOffGrid(tick_min)); }
        if out && inscription.trim().is_empty() { return Err(ApexError::PinNeedsInscription(tick_min)); }
        if epoch_min < MIN_EPOCH_MINUTES { return Err(ApexError::EpochTooShort(epoch_min)); }
        let i = (tick_min / PIN_STEP_MINUTES) as usize;
        self.pins[i] = Pin { tick_min, out, inscription: if out { inscription.trim().to_string() } else { String::new() }, epoch_min };
        Ok(())
    }
    pub fn set_gears(&mut self, _w: Wetware, engaged: bool) { self.gears_engaged = engaged; }
    pub fn pins_out(&self) -> Vec<&Pin> { self.pins.iter().filter(|p| p.out).collect() }
    /// The next strobe at or after `now_min` (minute of day, wraps midnight). None = sleep
    /// with nothing armed, or gears disengaged (then nothing ever strobes).
    pub fn next_strobe(&self, now_min: u32) -> Option<(&Pin, u32)> {
        if !self.gears_engaged { return None; }
        let now = now_min % RING_MINUTES;
        self.pins.iter().filter(|p| p.out).map(|p| (p, (p.tick_min + RING_MINUTES - now) % RING_MINUTES)).min_by_key(|(_, wait)| *wait)
    }
    /// Minutes left in a strobe's epoch. 0 means the trip-claw has fired.
    pub fn epoch_remaining(pin: &Pin, strobe_min: u32, now_min: u32) -> u32 {
        let elapsed = (now_min + RING_MINUTES - strobe_min) % RING_MINUTES;
        pin.epoch_min.saturating_sub(elapsed)
    }
    pub fn epoch_expired(pin: &Pin, strobe_min: u32, now_min: u32) -> bool { Self::epoch_remaining(pin, strobe_min, now_min) == 0 }
}

// ───────────────────────────── the Toggle Switchboard ─────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle { On, Off }
/// A lamp is a READOUT. It never becomes a knob. Tripped ≠ Off: the circuit is live, this worker failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lamp { Ok, Tripped, Muted }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Circuit { pub id: String, pub toggle: Toggle, pub lamp: Lamp, /// flip-cover guard: billable or destructive
    pub guarded: bool }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Switchboard { pub circuits: Vec<Circuit> }

pub const STANDARD_CIRCUITS: [(&str, bool); 16] = [
    ("gmail", false), ("github", false), ("cdn", false), ("r2", false), ("d1", false),
    ("ringcentral", false), ("workers_ai", true), ("babel", true), ("write_ops", true), ("prod", true),
    // Wayne.com surfaces (inventory 2026-09-06): each exposes or executes, so each carries a
    // flip-cover. Declared OFF; arming one is a wetware act. `comms` is the one circuit that
    // reaches the LAN (the pre-existing ucc tunnel) and must say so wherever it is rendered.
    ("comms", true), ("shell", true), ("container", true), ("chat", true), ("canvas", true), ("task", true),
];
/// The six Wayne.com surface circuits, in inventory order. Kept as a named slice so a
/// renderer or a twin can assert the set without re-deriving it from the board.
pub const PLATFORM_SURFACES: [&str; 6] = ["comms", "shell", "container", "chat", "canvas", "task"];

impl Default for Switchboard { fn default() -> Self { Self::standard() } }

impl Switchboard {
    /// The standard board, every toggle OFF, every lamp Muted. Arming is a wetware act.
    pub fn standard() -> Self {
        Switchboard { circuits: STANDARD_CIRCUITS.iter().map(|(id, guarded)| Circuit { id: id.to_string(), toggle: Toggle::Off, lamp: Lamp::Muted, guarded: *guarded }).collect() }
    }
    fn find(&self, id: &str) -> Option<&Circuit> { self.circuits.iter().find(|c| c.id == id) }
    fn find_mut(&mut self, id: &str) -> Option<&mut Circuit> { self.circuits.iter_mut().find(|c| c.id == id) }
    /// Does the circuit exist this epoch? Only the toggle answers. A tripped lamp does not close it.
    pub fn allows(&self, id: &str) -> bool { matches!(self.find(id), Some(c) if c.toggle == Toggle::On) }
    pub fn set(&mut self, _w: Wetware, id: &str, t: Toggle) -> Result<(), ApexError> {
        let c = self.find_mut(id).ok_or_else(|| ApexError::UnknownCircuit(id.to_string()))?;
        c.toggle = t; if t == Toggle::On && c.lamp == Lamp::Muted { c.lamp = Lamp::Ok; } if t == Toggle::Off { c.lamp = Lamp::Muted; } Ok(())
    }
    /// A worker may trip a lamp — that is state, not policy. No token required.
    pub fn trip(&mut self, id: &str) -> Result<(), ApexError> {
        let c = self.find_mut(id).ok_or_else(|| ApexError::UnknownCircuit(id.to_string()))?; if c.toggle == Toggle::On { c.lamp = Lamp::Tripped; } Ok(())
    }
    /// Resetting a red lamp is a wetware act (the manual lever), and it does not unscrew any tripper.
    pub fn reset(&mut self, _w: Wetware, id: &str) -> Result<(), ApexError> {
        let c = self.find_mut(id).ok_or_else(|| ApexError::UnknownCircuit(id.to_string()))?; if c.toggle == Toggle::On { c.lamp = Lamp::Ok; } Ok(())
    }
    pub fn mask(&self) -> Vec<String> { self.circuits.iter().filter(|c| c.toggle == Toggle::On).map(|c| c.id.clone()).collect() }
    pub fn tripped(&self) -> Vec<String> { self.circuits.iter().filter(|c| c.lamp == Lamp::Tripped).map(|c| c.id.clone()).collect() }
    pub fn all_off(&self) -> bool { self.circuits.iter().all(|c| c.toggle == Toggle::Off) }
}

// ───────────────────────────── dual-gate writes · hard stops · armed states ───────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteTarget { Mock, Prod }

/// The three hard stops (dark circuit, dial cliff, epoch claw) plus the budget cliff inside the loop.
/// There is no fourth stop called "the model felt unsure" — that is already on the dial.
#[derive(Debug, Clone, PartialEq)]
pub enum Stop {
    DarkCircuit(String),
    DialCliff { need: u8, have: u8 },
    ProdCircuitDark,
    ProdBelowAssisted { have: u8 },
    BudgetCliff { need_usd: f32, remaining_usd: f32 },
    EpochClaw,
}

/// Write Ops toggle AND the dial's write bit — AND, never synonyms. Prod adds the prod toggle AND ASSISTED+.
pub fn may_write(dial: &PrecisionDialConfig, sb: &Switchboard, target: WriteTarget) -> Result<(), Stop> {
    if !sb.allows("write_ops") { return Err(Stop::DarkCircuit("write_ops".into())); }
    if !dial.write_clearance() { return Err(Stop::DialCliff { need: 50, have: dial.dial_position }); }
    if target == WriteTarget::Prod {
        if !sb.allows("prod") { return Err(Stop::ProdCircuitDark); }
        if !dial.prod_write_clearance() { return Err(Stop::ProdBelowAssisted { have: dial.dial_position }); }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step { pub tool: String, pub requires_write: Option<WriteTarget>, pub estimated_usd: f32 }

/// Order is load-bearing: circuit, then radius, then budget, then time. Escalate; never widen.
pub fn gate_step(step: &Step, dial: &PrecisionDialConfig, sb: &Switchboard, remaining_usd: f32, remaining_epoch_min: u32) -> Result<(), Stop> {
    if !sb.allows(&step.tool) { return Err(Stop::DarkCircuit(step.tool.clone())); }
    if let Some(t) = step.requires_write { may_write(dial, sb, t)?; }
    if step.estimated_usd > remaining_usd { return Err(Stop::BudgetCliff { need_usd: step.estimated_usd, remaining_usd }); }
    if remaining_epoch_min == 0 { return Err(Stop::EpochClaw); }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArmedState { AirGap, ArmedSleep, Sentinel, GuardedEpoch, Hotfix, Unchecked, Custom }

/// The states that matter, read off the three instruments. `strobing` = a pin is out and its epoch is live now.
pub fn armed_state(timer: &PinTimer, dial: &PrecisionDialConfig, sb: &Switchboard, strobing: bool) -> ArmedState {
    let d = dial.dial_position;
    if !timer.gears_engaged && sb.all_off() && d == 0 { return ArmedState::AirGap; }
    if d == 100 && !sb.all_off() { return ArmedState::Unchecked; }
    if !strobing && !timer.pins_out().is_empty() { return ArmedState::ArmedSleep; }
    if strobing && (85..=95).contains(&d) && sb.allows("prod") { return ArmedState::Hotfix; }
    if strobing && (10..=25).contains(&d) && !sb.allows("prod") { return ArmedState::Sentinel; }
    if strobing && (51..=75).contains(&d) { return ArmedState::GuardedEpoch; }
    ArmedState::Custom
}

impl ArmedState {
    pub fn name(&self) -> &'static str {
        match self { ArmedState::AirGap => "AIR-GAP", ArmedState::ArmedSleep => "ARMED SLEEP", ArmedState::Sentinel => "SENTINEL", ArmedState::GuardedEpoch => "GUARDED EPOCH", ArmedState::Hotfix => "HOTFIX", ArmedState::Unchecked => "UNCHECKED", ArmedState::Custom => "CUSTOM" }
    }
}
