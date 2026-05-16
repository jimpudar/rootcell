import { expect } from "vitest";
import { join } from "node:path";
import { formatVmList } from "../../rootcell.ts";
import { TEST_INSTANCE } from "./fixtures.ts";
import { VmListEntrySchema } from "./schemas.ts";
import type { IntegrationFlow } from "./rootcell-flow.ts";

export async function expectProviderNeutralVmList(flow: IntegrationFlow): Promise<void> {
  const entries = await flow.app.listVms();
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry).toEqual(expect.schemaMatching(VmListEntrySchema));
    expect(entry.instance).toBe(TEST_INSTANCE);
    expect(entry.state).toBe("running");
  }
  expect(formatVmList(entries)).toContain("INSTANCE");
  expect(formatVmList(entries)).toContain("running");
}

export async function expectFirewallServices(flow: IntegrationFlow): Promise<void> {
  await flow.firewallSh("systemctl is-active mitmproxy-explicit mitmproxy-transparent dnsmasq >/dev/null");
}

export async function expectSpyWiring(flow: IntegrationFlow): Promise<void> {
  flow.hostCommandOk("bash", ["-c", `'${join(flow.repoDir, "rootcell")}' --instance ${TEST_INSTANCE} spy --help | grep -q -- '--tui'`]);
  flow.hostCommandOk("bash", ["-c", `'${join(flow.repoDir, "rootcell")}' --instance ${TEST_INSTANCE} spy --tui --raw --no-dedupe --help | grep -q -- '--tui'`]);
  await flow.firewallSh("test -x /etc/agent-vm/agent_spy.py && test -x /etc/agent-vm/agent_spy_tui.py && command -v python3 >/dev/null && python3 -c \"import textual\" && test -d /run/agent-vm-spy");
}

export async function expectPrivateNetworkRouting(flow: IntegrationFlow): Promise<void> {
  const network = flow.providers.network.plan().guest;
  await flow.agentSh(`ip -4 -o addr show ${network.agentPrivateInterface} | grep -q '${network.agentIp}/'`);
  await flow.agentSh(`ip route show default | grep -q '^default via ${network.firewallIp} dev ${network.agentPrivateInterface}'`);
  await flow.firewallSh(`ip -4 -o addr show ${network.firewallPrivateInterface} | grep -q '${network.firewallIp}/'`);
  await flow.agentSh(`dig @${network.firewallIp} +short +time=3 +tries=1 github.com | grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'`);
}

export async function expectGuestTools(flow: IntegrationFlow): Promise<void> {
  await flow.agentSh("command -v pi && command -v rg && command -v gh && command -v jq >/dev/null");
  await flow.agentSh("out=$(pi --help) && [ -n \"$out\" ]");
}

export async function expectProxyPolicy(flow: IntegrationFlow): Promise<void> {
  await flow.agentSh("code=$(curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w \"%{http_code}\" https://github.com) && [[ \"$code\" =~ ^[23] ]]");
  await flow.agentShFails("curl -sS --connect-timeout 2 --max-time 3 -o /dev/null http://github.com");
  await flow.agentShFails("curl -sS --connect-timeout 3 --max-time 5 -o /dev/null https://example.com");
  await flow.agentShFails("curl -sS --connect-timeout 3 --max-time 5 -o /dev/null https://pythonhosted.org");
  await expectDenySniNoBypassWithInsecureCurl(flow);
  await expectDenySniNoMitmproxyCert(flow);
  await expectAllowedHttpsCertIsOurs(flow);
  await expectSniPinnedToUpstreamIdentity(flow);
  await expectHostMustAgreeWithSni(flow);
}

export async function expectDnsPolicy(flow: IntegrationFlow): Promise<void> {
  await flow.agentSh("dig +short +time=3 +tries=1 github.com | grep -qE \"^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$\"");
  await flow.agentSh("dig example.com +time=3 +tries=1 2>&1 | grep -q \"status: REFUSED\"");
}

export async function expectSshPolicy(flow: IntegrationFlow): Promise<void> {
  await flow.agentSh("ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 -T git@github.com 2>&1 | grep -qE \"(successfully authenticated|Permission denied|does not provide shell)\"");
  await flow.agentShFails("ssh -o BatchMode=yes -o ConnectTimeout=5 -T -p 22 root@1.1.1.1");
}

async function expectDenySniNoBypassWithInsecureCurl(flow: IntegrationFlow): Promise<void> {
  const result = await flow.agentShCapture("curl -sk --connect-timeout 3 --max-time 5 -o /dev/null -w \"%{size_download}\" https://pythonhosted.org");
  const size = result.stdout.trim() || "0";
  expect(size).toBe("0");
}

async function expectDenySniNoMitmproxyCert(flow: IntegrationFlow): Promise<void> {
  const result = await flow.agentShCapture("curl -skv --connect-timeout 3 --max-time 5 -o /dev/null https://pythonhosted.org 2>&1 | grep -i issuer");
  expect(result.stdout).not.toMatch(/mitmproxy/i);
}

async function expectAllowedHttpsCertIsOurs(flow: IntegrationFlow): Promise<void> {
  const issuer = await flow.agentSh("curl -sSv --connect-timeout 5 --max-time 10 -o /dev/null https://github.com 2>&1 | grep -i \"issuer:\" | head -n1");
  expect(issuer).toContain("agent-vm proxy CA");
}

async function expectSniPinnedToUpstreamIdentity(flow: IntegrationFlow): Promise<void> {
  const result = await flow.agentShCapture("curl -sk --connect-timeout 3 --max-time 5 -D - --resolve github.com:443:1.1.1.1 https://github.com");
  if (result.stdout.length === 0) {
    return;
  }
  expect(result.stdout).toMatch(/^server: mitmproxy/im);
  expect(result.stdout).toMatch(/Certificate verify failed: hostname mismatch/i);
}

async function expectHostMustAgreeWithSni(flow: IntegrationFlow): Promise<void> {
  const result = await flow.agentShCapture("curl -sS --connect-timeout 3 --max-time 5 -o /dev/null -w \"%{http_code}\" -H \"Host: objects.githubusercontent.com\" https://api.github.com/");
  const code = result.stdout.trim();
  expect(code === "000" || code.length === 0).toBe(true);
}
