import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("xboard-edge has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("machine form validates while typing", () => {
  const adminBundle = fs.readFileSync("public/assets/index-CEIYH7i8.js", "utf8");
  const machineFormStart = adminBundle.indexOf("const t3t=");
  assert.notEqual(machineFormStart, -1);
  assert.match(adminBundle.slice(machineFormStart, machineFormStart + 500), /mode:"onChange"/);
});
