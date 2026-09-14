// Mint the local dsh web browser-session cookie for scripts/docs-screenshot.mjs.
//
// The GUI signs its session cookie with a per-install secret stored in the
// local credential file (`~/.dsh/.credentials.yaml`, current-user only). This
// script reads that secret and prints a short-lived signed cookie value to
// stdout so a driven headless browser can authenticate against the loopback
// GUI. Nothing leaves the machine, nothing is written anywhere, and the secret
// itself is never printed.
//
// Usage:
//   $env:NO_PROXY="127.0.0.1,localhost"
//   $env:THM_COOKIE = (node scripts/docs-screenshot-auth.mjs).Trim()
//   node scripts/docs-screenshot.mjs
//
// Optional: THM_AUTHORITY (default 127.0.0.1:3080), THM_MAX_AGE_DAYS (default 30).
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const credentialsPath = process.env.THM_CREDENTIALS ?? join(homedir(), ".dsh", ".credentials.yaml");
const text = readFileSync(credentialsPath, "utf8");
const match = /client-connection\/browser-session:\s*\n(?:.*\n)*?\s+secret:\s*(\S+)/.exec(text);
if (match === null) throw new Error(`browser-session secret not found in ${credentialsPath}`);

const b64url = (value) => Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(match[1].trim().replaceAll("-", "+").replaceAll("_", "/"), "base64");
if (secret.byteLength !== 32) throw new Error(`unexpected browser-session secret length ${secret.byteLength}`);

const authority = process.env.THM_AUTHORITY ?? "127.0.0.1:3080";
const name = `dsh-auth-${b64url(createHash("sha256").update(authority).digest())}`;
const maxAgeMs = Number(process.env.THM_MAX_AGE_DAYS ?? 30) * 24 * 60 * 60 * 1000;
const issuedAt = Date.now();
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + maxAgeMs }), "utf8"));
const value = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
process.stdout.write(`${name}=${value}\n`);
