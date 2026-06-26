import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("xboard-edge has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});
