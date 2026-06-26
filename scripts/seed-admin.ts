import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const salt = "xboard-cloudflare-admin";
const hash = crypto.pbkdf2Sync("adminadmin", salt, 100000, 32, "sha256").toString("hex");
const password = `pbkdf2$sha256$100000$${salt}$${hash}`;
const sql = `INSERT INTO v2_user(email, password, password_algo, password_salt, uuid, token, transfer_enable, is_admin, is_staff, created_at, updated_at) VALUES ('admin@admin.com', '${password}', 'pbkdf2', '${salt}', '00000000-0000-4000-8000-000000000001', 'admin-default-token-change-me', 1099511627776, 1, 1, unixepoch(), unixepoch()) ON CONFLICT(email) DO UPDATE SET password = excluded.password, password_algo = excluded.password_algo, password_salt = excluded.password_salt, is_admin = 1, is_staff = 1, updated_at = unixepoch();`;
execFileSync("npx", ["wrangler", "d1", "execute", "xboard-db", "--command", sql], { stdio: "inherit", shell: true });
console.log("Seeded default super administrator: admin@admin.com / adminadmin");
