// The parser must prove it can refuse: unknown op, bad path, remove without target. fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, parsePath, deprovisions, ScimError } from "../scim_patch.js";
const S = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const user = () => ({ id: "u1", userName: "a@example.com", active: true, name: { givenName: "A", familyName: "B" }, emails: [{ value: "a@example.com", type: "work", primary: true }], groups: [] });
const group = () => ({ id: "g1", displayName: "Ops", members: [{ value: "u1" }, { value: "u2" }] });

test("deprovision: replace active:false is detected and applied; sessions are the caller's to revoke", () => {
  const p = { schemas: [S], Operations: [{ op: "replace", path: "active", value: false }] };
  assert.equal(deprovisions(p), true);
  const { resource, applied } = applyPatch(user(), p); assert.equal(resource.active, false); assert.equal(applied.length, 1);
  assert.equal(deprovisions({ Operations: [{ op: "replace", path: "active", value: true }] }), false);
  assert.equal(deprovisions({ Operations: [{ op: "replace", value: { active: false } }] }), true, "path-less form counts too");
});

test("sub-attribute and filtered multi-valued paths: name.givenName, emails[type eq \"work\"].value", () => {
  const { resource } = applyPatch(user(), { Operations: [{ op: "replace", path: "name.givenName", value: "Alex" }, { op: "replace", path: 'emails[type eq "work"].value', value: "alex@example.com" }] });
  assert.equal(resource.name.givenName, "Alex"); assert.equal(resource.emails[0].value, "alex@example.com"); assert.equal(resource.emails[0].primary, true, "siblings untouched");
  assert.deepEqual(parsePath('emails[type eq "work"].value'), { attr: "emails", filter: { attr: "type", value: "work" }, sub: "value" });
  assert.deepEqual(parsePath("name.givenName"), { attr: "name", filter: null, sub: "givenName" });
});

test("groups: add members (deduplicated), remove by filter, remove by value list", () => {
  let g = applyPatch(group(), { Operations: [{ op: "add", path: "members", value: [{ value: "u3" }, { value: "u2" }] }] }).resource;
  assert.deepEqual(g.members.map((m) => m.value), ["u1", "u2", "u3"]);
  g = applyPatch(g, { Operations: [{ op: "remove", path: 'members[value eq "u2"]' }] }).resource;
  assert.deepEqual(g.members.map((m) => m.value), ["u1", "u3"]);
  g = applyPatch(g, { Operations: [{ op: "remove", path: "members", value: [{ value: "u1" }] }] }).resource;
  assert.deepEqual(g.members.map((m) => m.value), ["u3"]);
});

test("path-less add/replace merges an object; the input resource is never mutated", () => {
  const u = user(); const { resource } = applyPatch(u, { Operations: [{ op: "add", value: { title: "Advisor", groups: [{ value: "g1" }] } }] });
  assert.equal(resource.title, "Advisor"); assert.deepEqual(resource.groups, [{ value: "g1" }]); assert.equal(u.title, undefined); assert.deepEqual(u.groups, []);
});

test("CONTROL — refusals carry RFC 7644 error shapes: unknown op, invalid path, remove without target, missing value, wrong schema", () => {
  const bad = (ops, scimType, schemas) => { try { applyPatch(user(), { ...(schemas ? { schemas } : {}), Operations: ops }); assert.fail("expected ScimError"); } catch (e) { assert.ok(e instanceof ScimError); assert.equal(e.status, 400); assert.equal(e.scimType, scimType); assert.equal(e.toJSON().schemas[0], "urn:ietf:params:scim:api:messages:2.0:Error"); } };
  bad([{ op: "move", path: "active", value: false }], "invalidSyntax");
  bad([{ op: "replace", path: "emails[type gt 1].value", value: "x" }], "invalidPath");
  bad([{ op: "remove", path: "nickName" }], "noTarget");
  bad([{ op: "remove", path: 'emails[type eq "home"]' }], "noTarget");
  bad([{ op: "replace", path: "title" }], "invalidValue");
  bad([{ op: "replace", path: "active", value: false }], "invalidSyntax", ["urn:wrong"]);
  assert.throws(() => applyPatch(user(), { Operations: [] }), ScimError);
});
