import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
const cmd = process.argv[2] || "typecheck";
const workers = ["xboard-edge", "xboard-subscription", "xboard-server", "xboard-jobs", "xboard-cron"];
for (const worker of workers) {
  const cwd = `workers/${worker}`;
  if (!existsSync(`${cwd}/node_modules`)) {
    const install = spawnSync("npm", ["install"], { cwd, stdio: "inherit", shell: true });
    if (install.status) process.exit(install.status);
  }
  const run = spawnSync("npm", ["run", cmd], { cwd, stdio: "inherit", shell: true });
  if (run.status) process.exit(run.status);
}
