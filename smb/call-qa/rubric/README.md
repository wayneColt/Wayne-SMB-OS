# rubrics
- `wayne-smb-v1.json` — the domain-wide four-category coaching rubric (greeting · discovery · action · empathy). Any shop.
- `client-rubric.example.json` — the SHAPE of a client's intake rules (Scheduled / Lost / revenue / Unassigned). Replace with the client's wording per launch; the gate applies the rules in code.
Every grade row carries `rubric_version = "<client-rubric>+wayne-smb-v1"`. Revenue is `NO_SIGNAL` until a real Value column is joined. `fabricated:false`
