import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
const cmd = process.argv[2] || "typecheck";
const extraArgs = process.argv.slice(3);
const workers = ["xboard-edge", "xboard-subscription", "xboard-server", "xboard-jobs", "xboard-cron", "xboard-analytics"];
function npmRun(args, cwd) {
  const command = ["npm", ...args].join(" ");
  const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (result.error) throw result.error;
  return result;
}
for (const worker of workers) {
  const cwd = `workers/${worker}`;
  if (!existsSync(`${cwd}/node_modules`)) {
    const install = npmRun(["install"], cwd);
    if (install.status) process.exit(install.status);
  }
  const run = npmRun(["run", cmd, ...(extraArgs.length ? ["--", ...extraArgs] : [])], cwd);
  if (run.status) process.exit(run.status);
}
