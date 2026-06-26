const base = process.env.XBOARD_EDGE_URL;
if (!base) {
  console.error("Set XBOARD_EDGE_URL before running smoke tests.");
  process.exit(1);
}
const res = await fetch(new URL("/health", base));
if (!res.ok) throw new Error(`health failed: ${res.status}`);
console.log(await res.text());
