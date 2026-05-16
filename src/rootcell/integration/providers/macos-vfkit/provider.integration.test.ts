import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { AGENT_IP, AGENT_VM_NAME, FIREWALL_VM_NAME, LIFECYCLE_INSTANCE, TEST_INSTANCE } from "../../common/fixtures.ts";
import { IntegrationFlow } from "../../common/rootcell-flow.ts";
import { selectedIntegrationProvider } from "../../common/provider-spec.ts";
import type { VfkitNetworkAttachment } from "../../../providers/macos-vfkit-network.ts";
import { macOsVfkitIntegrationProvider, prepareLifecycleInstance, processIsRunning, readJson, stopLifecycleProcesses, vfkitPrivateLinkStatePath, vfkitStatePath } from "./provider.ts";
import { VfkitNetworkAttachmentSchema, VfkitPrivateLinkStateFileSchema, VfkitVmStateFileSchema } from "./schemas.ts";

const shouldRun = selectedIntegrationProvider().id === macOsVfkitIntegrationProvider.id;
let flow: IntegrationFlow<VfkitNetworkAttachment>;

describe.skipIf(!shouldRun)("macos-vfkit integration provider", { concurrent: false }, () => {
  beforeAll(async () => {
    flow = new IntegrationFlow(macOsVfkitIntegrationProvider, import.meta.url);
    await flow.provision();
  });

  test("exposes vfkit network attachment shape through the provider bundle", () => {
    const plan = flow.providers.network.plan();
    expect(plan.provider).toBe("macos-vfkit");
    expect(plan.vms.agent).toEqual(expect.schemaMatching(VfkitNetworkAttachmentSchema.extend({
      role: z.literal("agent"),
      useNat: z.literal(false),
    })));
    expect(plan.vms.firewall).toEqual(expect.schemaMatching(VfkitNetworkAttachmentSchema.extend({
      role: z.literal("firewall"),
      useNat: z.literal(true),
      controlMac: z.string().regex(/^52:54:00:/),
    })));
    expect(plan.vms.agent.privateSocketPath).toContain("/vfkit/network/agent-private.sock");
    expect(plan.vms.firewall.privateSocketPath).toContain("/vfkit/network/firewall-private.sock");
  });

  test("records running vfkit VM state files", () => {
    const agent = readJson(vfkitStatePath(flow.repoDir, AGENT_VM_NAME));
    const firewall = readJson(vfkitStatePath(flow.repoDir, FIREWALL_VM_NAME));
    expect(agent).toEqual(expect.schemaMatching(VfkitVmStateFileSchema.extend({
      name: z.literal(AGENT_VM_NAME),
      role: z.literal("agent"),
    })));
    expect(firewall).toEqual(expect.schemaMatching(VfkitVmStateFileSchema.extend({
      name: z.literal(FIREWALL_VM_NAME),
      role: z.literal("firewall"),
      controlMac: z.string().regex(/^52:54:00:/),
      firewallControlIp: z.string(),
    })));
    expect(processIsRunning(Number(agent.pid))).toBe(true);
    expect(processIsRunning(Number(firewall.pid))).toBe(true);
    expect(agent.controlMac).toBeUndefined();
  });

  test("records running private-link state", () => {
    const state = readJson(vfkitPrivateLinkStatePath(flow.repoDir));
    expect(state).toEqual(expect.schemaMatching(VfkitPrivateLinkStateFileSchema));
    expect(processIsRunning(Number(state.pid))).toBe(true);
    expect(String(state.agentSocketPath)).toContain("/vfkit/network/agent-private.sock");
    expect(String(state.firewallSocketPath)).toContain("/vfkit/network/firewall-private.sock");
  });

  test("writes a ProxyJump SSH config for direct firewall and jumped agent access", () => {
    const config = readFileSync(sshConfigPath(flow.repoDir), "utf8");
    expect(config).toContain("Host rootcell-firewall");
    expect(config).toContain("Host rootcell-agent");
    expect(config).toContain("ProxyJump rootcell-firewall");
  });

  test("supports host SSH to firewall and agent through the vfkit transport", () => {
    sshGuest(flow, "rootcell-firewall", "true");
    sshGuest(flow, "rootcell-agent", "true");
  });

  test("keeps the agent private link hostless", async () => {
    await flow.agentSh("test \"$(find /sys/class/net -mindepth 1 -maxdepth 1 ! -name lo | wc -l | tr -d \" \")\" = 1");
    await flow.agentSh("! ip link show enp0s2 >/dev/null 2>&1");
    await flow.agentSh("! ip -4 -o addr show | grep -q '192\\.168\\.5\\.'");
    flow.hostCommandFails("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=3",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `luser@${AGENT_IP}`,
      "true",
    ]);
  });

  test("rootcell remove deletes vfkit lifecycle state", async () => {
    await prepareLifecycleInstance(flow.repoDir);
    try {
      const existing = flow.rootcell(["list", "--instance", LIFECYCLE_INSTANCE]);
      expectRootcellListState(existing, LIFECYCLE_INSTANCE, `agent-${LIFECYCLE_INSTANCE}`, "stopped");
      expectRootcellListState(existing, LIFECYCLE_INSTANCE, `firewall-${LIFECYCLE_INSTANCE}`, "stopped");

      const stopOutput = flow.rootcell(["stop", "--instance", LIFECYCLE_INSTANCE]);
      expect(stopOutput).toContain(`stopped ${LIFECYCLE_INSTANCE}`);
      const stopped = flow.rootcell(["list", "--instance", LIFECYCLE_INSTANCE]);
      expectRootcellListState(stopped, LIFECYCLE_INSTANCE, `agent-${LIFECYCLE_INSTANCE}`, "stopped");
      expectRootcellListState(stopped, LIFECYCLE_INSTANCE, `firewall-${LIFECYCLE_INSTANCE}`, "stopped");

      const removeOutput = flow.rootcell(["remove", "--instance", LIFECYCLE_INSTANCE]);
      expect(removeOutput).toContain(`stopped ${LIFECYCLE_INSTANCE}, deleted state`);
      for (const path of [
        join(lifecycleInstanceDir(flow.repoDir), "vfkit", `agent-${LIFECYCLE_INSTANCE}`),
        join(lifecycleInstanceDir(flow.repoDir), "vfkit", `firewall-${LIFECYCLE_INSTANCE}`),
        join(lifecycleInstanceDir(flow.repoDir), "vfkit", "network"),
      ]) {
        expect(existsSync(path)).toBe(false);
      }
      const missing = flow.rootcell(["list", "--instance", LIFECYCLE_INSTANCE]);
      expectRootcellListState(missing, LIFECYCLE_INSTANCE, `agent-${LIFECYCLE_INSTANCE}`, "missing");
      expectRootcellListState(missing, LIFECYCLE_INSTANCE, `firewall-${LIFECYCLE_INSTANCE}`, "missing");
    } finally {
      await stopLifecycleProcesses(flow.repoDir);
      rmSync(lifecycleInstanceDir(flow.repoDir), { recursive: true, force: true });
    }
  });
});

function sshConfigPath(repoDir: string): string {
  return join(repoDir, ".rootcell", "instances", TEST_INSTANCE, "ssh", "config");
}

function lifecycleInstanceDir(repoDir: string): string {
  return join(repoDir, ".rootcell", "instances", LIFECYCLE_INSTANCE);
}

function sshGuest(flow: IntegrationFlow, alias: "rootcell-agent" | "rootcell-firewall", script: string): string {
  return flow.hostCommandOk("ssh", ["-F", sshConfigPath(flow.repoDir), alias, `bash -lc ${shellQuote(script)}`]);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function expectRootcellListState(output: string, instance: string, vm: string, state: string): void {
  const rows = output.split(/\r?\n/).slice(1).filter((line) => line.trim().length > 0);
  const found = rows.some((line) => {
    const cells = line.trim().split(/\s+/);
    return cells[0] === instance && cells[1] === vm && cells[2] === state;
  });
  expect(found, `expected rootcell list row ${instance} ${vm} ${state}, got:\n${output}`).toBe(true);
}
