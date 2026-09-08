/**
 * scim_patch.js — RFC 7644 §3.5.2 PatchOp applied to a SCIM resource, as a pure function.
 * No I/O, no dependencies. Supports the operations enterprise IdPs actually send:
 *   replace/add on an attribute ("active"), a sub-attribute ("name.givenName"),
 *   a multi-valued attribute filtered by `[attr eq "value"]` (emails[type eq "work"].value),
 *   add/remove on members[] (with or without a filter), and a path-less add/replace (object merge).
 * Returns { resource, applied } or throws ScimError { status, scimType, detail } (RFC 7644 §3.12).
 * A deprovision arrives as replace active:false — the caller must revoke sessions on it. fabricated:false
 */
export class ScimError extends Error {
  constructor(status, scimType, detail) { super(detail); this.status = status; this.scimType = scimType; this.detail = detail; }
  toJSON() { return { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(this.status), scimType: this.scimType, detail: this.detail }; }
}
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const PATH_RE = /^([A-Za-z][\w.:-]*?)(?:\[([A-Za-z][\w.]*)\s+eq\s+("([^"]*)"|true|false|\d+)\])?(?:\.([A-Za-z][\w]*))?$/;

export function parsePath(path) {
  if (path == null) return null;
  const m = PATH_RE.exec(String(path).trim());
  if (!m) throw new ScimError(400, "invalidPath", `unsupported path: ${path}`);
  const [, attr, fAttr, fRaw, fStr, sub] = m;
  let filter = null;
  if (fAttr) { const v = fStr !== undefined ? fStr : (fRaw === "true" ? true : fRaw === "false" ? false : Number(fRaw)); filter = { attr: fAttr, value: v }; }
  // "name.givenName" without a filter arrives as attr="name.givenName"; split once
  if (!filter && !sub && attr.includes(".")) { const i = attr.indexOf("."); return { attr: attr.slice(0, i), filter: null, sub: attr.slice(i + 1) }; }
  return { attr, filter, sub: sub || null };
}

function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function matches(item, f) { return item && typeof item === "object" && item[f.attr] === f.value; }

export function applyPatch(resource, patch) {
  if (!patch || !Array.isArray(patch.Operations) || !patch.Operations.length) throw new ScimError(400, "invalidSyntax", "Operations[] required");
  if (Array.isArray(patch.schemas) && !patch.schemas.includes(PATCH_SCHEMA)) throw new ScimError(400, "invalidSyntax", "PatchOp schema required");
  let r = clone(resource) || {};
  const applied = [];
  for (const raw of patch.Operations) {
    const op = String(raw.op || "").toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, "invalidSyntax", `unknown op: ${raw.op}`);
    const p = parsePath(raw.path);
    if (op === "remove" && !p) throw new ScimError(400, "noTarget", "remove requires a path");
    if (!p) {                                             // path-less add/replace: merge an object into the resource
      if (!raw.value || typeof raw.value !== "object" || Array.isArray(raw.value)) throw new ScimError(400, "invalidValue", "path-less add/replace needs an object value");
      for (const [k, v] of Object.entries(raw.value)) { r[k] = (op === "add" && Array.isArray(r[k]) && Array.isArray(v)) ? r[k].concat(v) : clone(v); }
      applied.push({ op, path: null, keys: Object.keys(raw.value) }); continue;
    }
    const { attr, filter, sub } = p;
    if (filter) {                                         // multi-valued attribute, filtered
      const arr = Array.isArray(r[attr]) ? r[attr] : [];
      const idx = arr.map((it, i) => (matches(it, filter) ? i : -1)).filter((i) => i >= 0);
      if (op === "remove") { if (!idx.length) throw new ScimError(400, "noTarget", `no ${attr} matches ${filter.attr} eq ${JSON.stringify(filter.value)}`); r[attr] = arr.filter((_, i) => !idx.includes(i)); applied.push({ op, path: raw.path, removed: idx.length }); continue; }
      if (!idx.length) { if (op === "add") { const item = sub ? { [filter.attr]: filter.value, [sub]: clone(raw.value) } : clone(raw.value); r[attr] = arr.concat([item]); applied.push({ op, path: raw.path, added: 1 }); continue; } throw new ScimError(400, "noTarget", `no ${attr} matches the filter`); }
      for (const i of idx) { if (sub) arr[i][sub] = clone(raw.value); else arr[i] = { ...arr[i], ...clone(raw.value) }; }
      r[attr] = arr; applied.push({ op, path: raw.path, touched: idx.length }); continue;
    }
    if (sub) {                                            // sub-attribute of a complex attribute
      if (op === "remove") { if (!r[attr] || !(sub in r[attr])) throw new ScimError(400, "noTarget", `${attr}.${sub} absent`); delete r[attr][sub]; applied.push({ op, path: raw.path }); continue; }
      r[attr] = r[attr] && typeof r[attr] === "object" ? r[attr] : {}; r[attr][sub] = clone(raw.value); applied.push({ op, path: raw.path }); continue;
    }
    if (op === "remove") { if (!(attr in r)) throw new ScimError(400, "noTarget", `${attr} absent`); if (Array.isArray(r[attr]) && Array.isArray(raw.value) && raw.value.length) { const keys = raw.value.map((v) => JSON.stringify(v.value !== undefined ? { value: v.value } : v)); r[attr] = r[attr].filter((it) => !keys.includes(JSON.stringify(it.value !== undefined ? { value: it.value } : it))); } else delete r[attr]; applied.push({ op, path: raw.path }); continue; }
    if (op === "add" && Array.isArray(r[attr]) && Array.isArray(raw.value)) { const have = new Set(r[attr].map((it) => JSON.stringify(it))); r[attr] = r[attr].concat(raw.value.filter((v) => !have.has(JSON.stringify(v)))); applied.push({ op, path: raw.path, added: raw.value.length }); continue; }
    if (raw.value === undefined) throw new ScimError(400, "invalidValue", `${op} ${attr} needs a value`);
    r[attr] = clone(raw.value); applied.push({ op, path: raw.path });
  }
  return { resource: r, applied };
}

/** the one call an offboarding needs: true when this patch deactivates the user (replace/add active:false) */
export function deprovisions(patch) {
  return Array.isArray(patch && patch.Operations) && patch.Operations.some((o) => { const op = String(o.op || "").toLowerCase(); if (!["replace", "add"].includes(op)) return false; if (o.path && String(o.path).trim() === "active") return o.value === false || o.value === "False" || o.value === "false"; return !o.path && o.value && typeof o.value === "object" && o.value.active === false; });
}
