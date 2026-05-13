#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface DnsmasqReloadPaths {
  readonly src: string;
  readonly dst: string;
}

export function dnsmasqAllowlistConfig(source: string): string {
  const lines: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine.length === 0 || rawLine.startsWith("#")) {
      continue;
    }
    lines.push(`server=/${rawLine}/1.1.1.1`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function generatedLineCount(config: string): number {
  if (config.length === 0) {
    return 0;
  }
  return config.endsWith("\n") ? config.split("\n").length - 1 : config.split("\n").length;
}

export function reloadDnsmasq(paths: DnsmasqReloadPaths): number {
  const tmp = `${paths.dst}.new`;
  const config = dnsmasqAllowlistConfig(readFileSync(paths.src, "utf8"));
  writeFileSync(tmp, config, "utf8");
  renameSync(tmp, paths.dst);
  runSystemctlRestartDnsmasq();
  const count = generatedLineCount(config);
  console.log(`reload: dnsmasq reconfigured (${String(count)} lines); mitmproxy will pick up changes on its next event.`);
  return 0;
}

function runSystemctlRestartDnsmasq(): void {
  const result = spawnSync("systemctl", ["restart", "dnsmasq"], {
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    process.exit(status);
  }
}

if (import.meta.path === process.argv[1]) {
  process.exit(reloadDnsmasq({
    src: "/etc/agent-vm/allowed-dns.txt",
    dst: "/etc/agent-vm/dnsmasq-allowlist.conf",
  }));
}
