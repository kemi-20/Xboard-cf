import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("xboard-edge has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("machine form validates while typing", () => {
  const adminBundle = fs.readFileSync("public/assets/index-CF20260713.js", "utf8");
  const machineFormStart = adminBundle.indexOf("const t3t=");
  assert.notEqual(machineFormStart, -1);
  assert.match(adminBundle.slice(machineFormStart, machineFormStart + 500), /mode:"onChange"/);
});

test("admin shell references the current bundle without caching", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /src="\/assets\/index-CF20260713\.js"/);
  assert.doesNotMatch(source, /src="\/assets\/index-CEIYH7i8\.js"/);
  assert.match(source, /"cache-control": "no-store, no-cache, must-revalidate"/);
});
