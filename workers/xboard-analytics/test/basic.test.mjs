import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/index.ts";

test("analytics queries are fixed templates with bounded input", () => {
  const query = __test.queryFor("user-rank", { start: -1, end: 999999999999, limit: 9999 });
  assert.match(query, /FROM xboard_user_traffic/);
  assert.match(query, /LIMIT 100$/);
  assert.doesNotMatch(query, /DROP TABLE/);
});

test("analytics ranking values normalize to original numeric fields", () => {
  assert.deepEqual(__test.normalize("user-rank", [{ entity: "user:7", u: "10", d: "20", total: "30" }]), [
    { user_id: 7, u: 10, d: 20, total: 30, previous_total: 0 }
  ]);
});

test("runtime load selects the latest samples and returns chart order", () => {
  const query = __test.queryFor("runtime-load", { entity_id: 3, start: 100, end: 1000, limit: 60 });
  assert.match(query, /ORDER BY recorded_at DESC LIMIT 60$/);
  assert.deepEqual(__test.normalize("runtime-load", [
    { recorded_at: "900", cpu: "20" },
    { recorded_at: "600", cpu: "10" }
  ]), [
    { recorded_at: 600, cpu: 10 },
    { recorded_at: 900, cpu: 20 }
  ]);
});
