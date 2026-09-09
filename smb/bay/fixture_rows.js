// fixture_rows.js — synthetic completed repair orders. No real shop, vehicle, person or number.
export const ROWS = [
  { repair_order_number: "RO-5001", vehicle_id: "V-1001", completed_date: "2026-06-03", miles_in: 88120, jobs: [
    { name: "Misfire diagnosis", category: "Diagnostic", note: "States misfire under load. Scanned P0303. Swapped coil 3 to 1, code followed. Recommend coil and plugs.", labor_hours: 1.0, labor_total: 149, parts_total: 0, technician_id: "T-1" },
    { name: "Replace ignition coil and spark plugs", category: "Engine Performance", note: "Replaced cyl 3 coil and all plugs. Road test, no misfire under load.", labor_hours: 1.4, labor_total: 210, parts_total: 186.4, technician_id: "T-1" } ] },
  { repair_order_number: "RO-5017", vehicle_id: "V-1001", completed_date: "2026-06-21", miles_in: 88910, jobs: [
    { name: "Misfire recheck", category: "Engine Performance", note: "Returned with misfire under load after coil replacement. Found injector 3 low flow. Replaced injector.", labor_hours: 1.6, labor_total: 240, parts_total: 132.5, technician_id: "T-2" } ] },
  { repair_order_number: "RO-5004", vehicle_id: "V-1002", completed_date: "2026-06-05", miles_in: 61200, jobs: [
    { name: "Brake pulsation", category: "Brakes", note: "Pulsation on braking at highway speed. Measured front rotors out of spec. Replaced front rotors and pads.", labor_hours: 1.8, labor_total: 270, parts_total: 248, technician_id: "T-2" } ] },
  { repair_order_number: "RO-5009", vehicle_id: "V-1003", completed_date: "2026-06-11", miles_in: 120400, jobs: [
    { name: "Coolant leak diagnosis", category: "Cooling", note: "Coolant leak at thermostat housing. Owner reachable at 555-010-4477 or owner@example.com, unit 1HGCM82633A004352. Replaced housing and gasket.", labor_hours: 1.2, labor_total: 180, parts_total: 64, technician_id: "T-1" } ] },
  { repair_order_number: "RO-5012", vehicle_id: "V-1004", completed_date: "2026-06-15", miles_in: 43900, jobs: [
    { name: "Oil change", category: "Maintenance", note: "Full synthetic, reset reminder.", labor_hours: 0.3, labor_total: 29, parts_total: 48, technician_id: "T-3" } ] },
  { repair_order_number: "RO-5020", vehicle_id: "V-1005", completed_date: "2026-06-28", miles_in: 97500, jobs: [
    { name: "Check engine light", category: "Diagnostic", note: "P0420 stored. Verified upstream sensor readings normal. Recommend converter replacement; owner declined.", labor_hours: 1.0, labor_total: 149, parts_total: 0, technician_id: "T-2" } ] },
];
