import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_INSTANCE = "test";
export const LIFECYCLE_INSTANCE = "lifecycle-test";
export const AGENT_VM_NAME = "agent-test";
export const FIREWALL_VM_NAME = "firewall-test";
export const FIREWALL_IP = "192.168.109.2";
export const AGENT_IP = "192.168.109.3";
export const NETWORK_PREFIX = "24";

export const defaultSpyOptions = {
  raw: false,
  dedupe: true,
  tui: false,
} as const;

export function findRepoDir(importMetaUrl: string): string {
  let dir = dirname(resolve(fileURLToPath(importMetaUrl)));
  for (;;) {
    if (existsSync(resolve(dir, "flake.nix")) && existsSync(resolve(dir, "completions"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(dirname(fileURLToPath(importMetaUrl)), "../../..");
    }
    dir = parent;
  }
}

export function applyIntegrationEnvironment(env: NodeJS.ProcessEnv): void {
  env.FIREWALL_IP = FIREWALL_IP;
  env.AGENT_IP = AGENT_IP;
  env.NETWORK_PREFIX = NETWORK_PREFIX;
}
