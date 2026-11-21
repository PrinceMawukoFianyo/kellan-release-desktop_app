// MUST be the first import in electron/main.ts, so DATABASE_URL is set
// before prisma/db.ts builds the Neon adapter.
// (Replace the contents of your existing env file with this one.)
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import { getLocalRoot } from "../prisma/db-local";

// Dev: project-root .env (absent in the packaged app, which is intended)
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });

const root = getLocalRoot();
const logFile = path.join(root, "startup.log");

function log(msg: string) {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging must never crash the app
  }
}

// Hide the password when writing a connection string to the log
const mask = (u: string) => u.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");

function readCloudJson(file: string): { databaseUrl?: string; directUrl?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Packaged app: <userData>/cloud.json -> { "databaseUrl": "...", "directUrl": "..." }
// If it isn't there yet, use a copy shipped inside the installer (extraResources)
// and save it to userData so it is found on every later start.
if (!process.env.DATABASE_URL) {
  const userFile = path.join(root, "cloud.json");
  let cfg = readCloudJson(userFile);
  let source = userFile;

  if (!cfg) {
    const resources = (process as any).resourcesPath as string | undefined;
    const bundled = resources ? path.join(resources, "cloud.json") : "";
    cfg = bundled ? readCloudJson(bundled) : null;
    if (cfg) {
      source = bundled;
      try {
        fs.mkdirSync(root, { recursive: true });
        fs.copyFileSync(bundled, userFile);
      } catch (e) {
        log(`could not copy cloud.json to ${userFile}: ${String(e)}`);
      }
    }
  }

  if (cfg?.databaseUrl) {
    // FIX: this was process.env.Kellan, so DATABASE_URL was never set
    process.env.DATABASE_URL = cfg.databaseUrl;
    process.env.DIRECT_URL = cfg.directUrl || cfg.databaseUrl;
    log(`cloud config loaded from ${source} (${mask(cfg.databaseUrl)})`);
  } else {
    log(`NO cloud.json found (looked in ${userFile} and the installer resources) - running local-only, nothing will sync`);
  }
}

const url = process.env.DATABASE_URL ?? "";
export const cloudConfigured = url !== "" && !url.includes("localhost");
log(`cloudConfigured = ${cloudConfigured}`);

const secretFile = path.join(root, "auth-secret.txt");
if (!process.env.NEXTAUTH_SECRET) {
  try {
    process.env.NEXTAUTH_SECRET = fs.readFileSync(secretFile, "utf8").trim();
  } catch {
    const s = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, s);
    process.env.NEXTAUTH_SECRET = s;
  }
}

// Cloud-only integrations (email, SMS, AI) aren't available on the desktop.
// Some SDKs throw at import time when a key is missing, which would crash pages.
const placeholders: Record<string, string> = {
  RESEND_API_KEY: "re_desktop_placeholder",
  EMAIL_FROM: "no-reply@localhost",
  FROM_EMAIL: "no-reply@localhost",
  OPENAI_API_KEY: "sk-desktop-placeholder",
  GEMINI_API_KEY: "desktop-placeholder",
  UPLOADTHING_APP_ID: "desktopapp",
  // UploadThing expects a base64 JSON token, so build a dummy one in that format
  UPLOADTHING_TOKEN: Buffer.from(
    JSON.stringify({ apiKey: "sk_live_desktop_placeholder", appId: "desktopapp", regions: ["sea1"] })
  ).toString("base64"),
};
for (const [k, v] of Object.entries(placeholders)) {
  if (!process.env[k]) process.env[k] = v;
}

process.env.NEXTAUTH_URL ??= "http://localhost:3000";