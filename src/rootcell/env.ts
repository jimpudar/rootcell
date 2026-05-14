import { existsSync, readFileSync } from "node:fs";
import type { SecretMapping } from "./types.ts";

export function loadDotEnv(path: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const equalsAt = line.indexOf("=");
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const key = equalsAt === -1 ? line : line.slice(0, equalsAt);
    const value = equalsAt === -1 ? "" : line.slice(equalsAt + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment variable name in .env: ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      continue;
    }
    env[key] = value;
  }
}

export function parseSecretMappings(text: string): SecretMapping[] {
  const mappings: SecretMapping[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const equalsAt = line.indexOf("=");
    if (equalsAt === -1) {
      throw new Error(`invalid secret entry in secrets.env: ${line}`);
    }
    const envName = line.slice(0, equalsAt);
    const service = line.slice(equalsAt + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error(`invalid secret environment variable name in secrets.env: ${envName}`);
    }
    if (service.length === 0) {
      throw new Error(`empty Keychain service name for ${envName}`);
    }
    mappings.push({ envName, service });
  }
  return mappings;
}

export function nixString(value: string): string {
  return JSON.stringify(value);
}
