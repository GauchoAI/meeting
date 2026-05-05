import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotEnv(): void {
  const path = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((candidate) => existsSync(candidate));
  if (!path) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [key, ...rest] = trimmed.split("=");
    process.env[key] ||= rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}

