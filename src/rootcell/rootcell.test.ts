import { describe, expect, test } from "bun:test";
import { parseRootcellArgs } from "./args.ts";
import { ROOTCELL_SUBCOMMANDS } from "./metadata.ts";
import { loadDotEnv, parseSecretMappings } from "./env.ts";
import { buildConfig } from "./rootcell.ts";
import { deriveVmNames, loadRootcellInstance, seedRootcellInstanceFiles } from "./instance.ts";
import { runCapture } from "./process.ts";
import { createProviderBundle } from "./providers/factory.ts";
import { limaListJsonContainsSocket, limaStatusFromOutput } from "./providers/lima.ts";
import { MacOsSocketVmnetNetworkProvider } from "./providers/macos-socket-vmnet.ts";
import { dnsmasqAllowlistConfig, generatedLineCount } from "../bin/reload.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ParsedRootcellRunArgs, RootcellInstance } from "./types.ts";

const ignoreLog = (): void => undefined;

describe("rootcell argument parsing", () => {
  test("parses known subcommands", () => {
    expect(runArgs(["provision"])).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "provision",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    expect(() => parseRootcellArgs(["provision", "ignored"])).toThrow("Too many non-option arguments");
  });

  test("parses pass-through guest commands", () => {
    expect(runArgs(["--", "nix", "flake", "update"])).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "",
      rest: ["nix", "flake", "update"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    expect(runArgs(["pi", "--model", "sonnet"])).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "",
      rest: ["pi", "--model", "sonnet"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
  });

  test("parses instance flags in any command position", () => {
    expect(runArgs(["--instance", "dev", "provision"])).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "provision",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    expect(runArgs(["allow", "--instance=dev"])).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "allow",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    expect(runArgs(["pi", "--instance", "dev", "--model", "sonnet"])).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "",
      rest: ["pi", "--model", "sonnet"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
  });

  test("rejects invalid instance names", () => {
    expect(() => parseRootcellArgs(["--instance", "../dev"])).toThrow("invalid instance name");
    expect(() => parseRootcellArgs(["provision", "--instance", "dev-"])).toThrow("invalid instance name");
  });

  test("parses spy flags", () => {
    expect(runArgs(["spy", "--tui", "--raw", "--no-dedupe"])).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "spy",
      rest: [],
      spyOptions: { raw: true, dedupe: false, tui: true },
    });
  });

  test("rejects unknown spy flags", () => {
    expect(() => parseRootcellArgs(["spy", "--bogus"])).toThrow("Unknown argument: bogus");
  });

  test("rejects unknown rootcell flags before commands", () => {
    expect(() => parseRootcellArgs(["--bogus", "provision"])).toThrow("Unknown argument: bogus");
    expect(() => parseRootcellArgs(["--raw", "spy"])).toThrow("Unknown argument: raw");
  });

  test("prints help without selecting a VM command", () => {
    const result = runCapture("./rootcell", ["--help"]);
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("rootcell completion");

    const helpCommand = runCapture("./rootcell", ["help"]);
    expect(helpCommand.stdout).toContain("Commands:");
  });
});

describe("environment parsing", () => {
  test("pre-existing environment wins over .env", () => {
    const env: NodeJS.ProcessEnv = { FIREWALL_IP: "1.2.3.4" };
    const path = "/tmp/rootcell-env-test";
    writeFileSync(path, "FIREWALL_IP=5.6.7.8\nAGENT_IP=9.9.9.9\n#SKIP=yes\n", "utf8");
    loadDotEnv(path, env);
    expect(env.FIREWALL_IP).toBe("1.2.3.4");
    expect(env.AGENT_IP).toBe("9.9.9.9");
    expect(env["#SKIP"]).toBeUndefined();
  });

  test("loads no-equals env entries as empty values", () => {
    const env: NodeJS.ProcessEnv = {};
    const path = "/tmp/rootcell-env-empty-test";
    writeFileSync(path, "EMPTY_VALUE\n", "utf8");
    loadDotEnv(path, env);
    expect(env.EMPTY_VALUE).toBe("");
  });

  test("validates secret mappings", () => {
    expect(parseSecretMappings("AWS_BEARER_TOKEN_BEDROCK=aws-bedrock-api-key\n")).toEqual([
      { envName: "AWS_BEARER_TOKEN_BEDROCK", service: "aws-bedrock-api-key" },
    ]);
    expect(() => parseSecretMappings("1BAD=service\n")).toThrow("invalid secret environment variable name");
    expect(() => parseSecretMappings("BAD\n")).toThrow("invalid secret entry");
    expect(() => parseSecretMappings("BAD=\n")).toThrow("empty Keychain service name");
  });

  test("builds config from instance state", () => {
    const config = buildConfig("/repo", { VM_START_TIMEOUT: "5s" }, fakeInstance("dev"));
    expect(config.agentVm).toBe("agent-dev");
    expect(config.firewallVm).toBe("firewall-dev");
    expect(config.firewallIp).toBe("192.168.109.2");
    expect(config.agentIp).toBe("192.168.109.3");
    expect(config.vmnetSocketPath).toBe("/private/var/run/rootcell/501/dev.sock");
    expect(config.vmStartTimeout).toBe("5s");
  });
});

describe("VM and network providers", () => {
  test("factory wires the current Lima and macOS vmnet providers", () => {
    const providers = createProviderBundle(buildConfig("/repo", {}, fakeInstance("dev")), ignoreLog);
    expect(providers.network.id).toBe("macos-socket-vmnet");
    expect(providers.vm.id).toBe("lima");
  });

  test("macOS socket vmnet provider exposes guest config and Lima attachments", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const plan = new MacOsSocketVmnetNetworkProvider(config, ignoreLog).plan();
    expect(plan).toEqual({
      provider: "macos-socket-vmnet",
      guest: {
        firewallIp: "192.168.109.2",
        agentIp: "192.168.109.3",
        networkPrefix: 24,
        agentPrivateInterface: "enp0s1",
        firewallPrivateInterface: "enp0s2",
        firewallEgressInterface: "enp0s1",
      },
      vms: {
        agent: {
          kind: "lima-socket",
          socketPath: "/private/var/run/rootcell/501/dev.sock",
          sshOverVsock: true,
          disableDefaultUsernet: true,
          useDefaultNat: false,
        },
        firewall: {
          kind: "lima-socket",
          socketPath: "/private/var/run/rootcell/501/dev.sock",
          sshOverVsock: true,
          disableDefaultUsernet: false,
          useDefaultNat: true,
        },
      },
    });
  });

  test("Lima status output maps to provider-neutral VM states", () => {
    expect(limaStatusFromOutput("")).toEqual({ state: "missing" });
    expect(limaStatusFromOutput("Running\n")).toEqual({ state: "running" });
    expect(limaStatusFromOutput("Stopped")).toEqual({ state: "stopped" });
    expect(limaStatusFromOutput("Broken")).toEqual({ state: "unexpected", detail: "Broken" });
  });

  test("Lima socket compatibility parser finds nested socket attachments", () => {
    const socketPath = "/private/var/run/rootcell/501/dev.sock";
    const output = JSON.stringify([
      {
        name: "agent-dev",
        config: {
          networks: [
            { socket: socketPath },
          ],
        },
      },
    ]);
    expect(limaListJsonContainsSocket(output, socketPath)).toBe(true);
    expect(limaListJsonContainsSocket(output, "/private/var/run/rootcell/501/other.sock")).toBe(false);
    expect(limaListJsonContainsSocket(`{"socket":${JSON.stringify(socketPath)}`, socketPath)).toBe(true);
  });
});

describe("instance state", () => {
  test("derives VM names from instance names", () => {
    expect(deriveVmNames("default")).toEqual({ agentVm: "agent", firewallVm: "firewall" });
    expect(deriveVmNames("dev")).toEqual({ agentVm: "agent-dev", firewallVm: "firewall-dev" });
  });

  test("allocates stable unique /24 networks", () => {
    const repo = makeInstanceRepo();
    try {
      seedRootcellInstanceFiles(repo, "default", ignoreLog);
      const envA: NodeJS.ProcessEnv = {};
      loadDotEnv(join(repo, ".rootcell/instances/default/.env"), envA);
      const defaultInstance = loadRootcellInstance(repo, "default", envA);

      seedRootcellInstanceFiles(repo, "dev", ignoreLog);
      const envB: NodeJS.ProcessEnv = {};
      loadDotEnv(join(repo, ".rootcell/instances/dev/.env"), envB);
      const devInstance = loadRootcellInstance(repo, "dev", envB);

      expect(defaultInstance.state.subnet).toBe("192.168.100.0");
      expect(defaultInstance.state.firewallIp).toBe("192.168.100.2");
      expect(devInstance.state.subnet).toBe("192.168.101.0");
      expect(devInstance.state.agentIp).toBe("192.168.101.3");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("honors explicit first-run .2/.3 subnet pins", () => {
    const repo = makeInstanceRepo();
    try {
      seedRootcellInstanceFiles(repo, "dev", ignoreLog);
      const env: NodeJS.ProcessEnv = {
        FIREWALL_IP: "192.168.109.2",
        AGENT_IP: "192.168.109.3",
        NETWORK_PREFIX: "24",
      };
      const instance = loadRootcellInstance(repo, "dev", env);
      expect(instance.state.subnet).toBe("192.168.109.0");
      expect(instance.state.firewallIp).toBe("192.168.109.2");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects duplicate instance subnets", () => {
    const repo = makeInstanceRepo();
    try {
      mkdirSync(join(repo, ".rootcell/instances/default"), { recursive: true });
      mkdirSync(join(repo, ".rootcell/instances/dev"), { recursive: true });
      writeFileSync(join(repo, ".rootcell/instances/default/state.json"), stateJson("default", "192.168.100"), "utf8");
      writeFileSync(join(repo, ".rootcell/instances/dev/state.json"), stateJson("dev", "192.168.100"), "utf8");
      expect(() => loadRootcellInstance(repo, "default", {})).toThrow("allocated to multiple rootcell instances");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("reload helper", () => {
  test("generates dnsmasq server entries from non-comment lines", () => {
    const config = dnsmasqAllowlistConfig("# comment\n\nexample.com\n*.example.org\n");
    expect(config).toBe("server=/example.com/1.1.1.1\nserver=/*.example.org/1.1.1.1\n");
    expect(generatedLineCount(config)).toBe(2);
  });
});

describe("completion files", () => {
  test("bash and zsh completions are generated by yargs", () => {
    const bash = readFileSync("completions/rootcell.bash", "utf8");
    const zsh = readFileSync("completions/rootcell.zsh", "utf8");
    expect(bash).toBe(generatedCompletion("/bin/bash"));
    expect(zsh).toBe(generatedCompletion("/bin/zsh"));
    expect(bash).toContain("yargs command completion script");
    expect(zsh).toContain("yargs command completion script");
  });

  test("yargs completion API includes all typed subcommands", () => {
    const choices = runCapture("./rootcell", ["--get-yargs-completions", "rootcell", ""], {
      env: completionEnv("/bin/bash"),
    }).stdout;
    for (const subcommand of ROOTCELL_SUBCOMMANDS) {
      expect(choices).toContain(subcommand.name);
    }
  });
});

function runArgs(args: readonly string[]): ParsedRootcellRunArgs {
  const parsed = parseRootcellArgs(args);
  if (parsed.kind !== "run") {
    throw new Error("expected parsed rootcell run args");
  }
  return parsed;
}

function generatedCompletion(shell: string): string {
  return stripTrailingBlankLine(runCapture("./rootcell", ["completion"], { env: completionEnv(shell) }).stdout);
}

function completionEnv(shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SHELL: shell };
  delete env.ZSH_NAME;
  return env;
}

function stripTrailingBlankLine(text: string): string {
  return text.endsWith("\n\n") ? text.slice(0, -1) : text;
}

describe("Lima templates", () => {
  test("checked-in Lima YAMLs use unmanaged socket networks", () => {
    expect(readFileSync("nixos.yaml", "utf8")).toContain("socket:");
    expect(readFileSync("firewall.yaml", "utf8")).toContain("socket:");
    expect(readFileSync("nixos.yaml", "utf8")).not.toContain("lima: host");
    expect(readFileSync("firewall.yaml", "utf8")).not.toContain("lima: host");
  });
});

function fakeInstance(name: string): RootcellInstance {
  return {
    name,
    dir: `/repo/.rootcell/instances/${name}`,
    envPath: `/repo/.rootcell/instances/${name}/.env`,
    secretsPath: `/repo/.rootcell/instances/${name}/secrets.env`,
    proxyDir: `/repo/.rootcell/instances/${name}/proxy`,
    pkiDir: `/repo/.rootcell/instances/${name}/pki`,
    generatedDir: `/repo/.rootcell/instances/${name}/generated`,
    statePath: `/repo/.rootcell/instances/${name}/state.json`,
    state: {
      schemaVersion: 1,
      vmnetUuid: "00000000-0000-4000-8000-000000000001",
      subnet: "192.168.109.0",
      networkPrefix: 24,
      firewallIp: "192.168.109.2",
      agentIp: "192.168.109.3",
      socketPath: `/private/var/run/rootcell/501/${name}.sock`,
      pidPath: `/private/var/run/rootcell/501/${name}.pid`,
    },
  };
}

function makeInstanceRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rootcell-instance-test-"));
  mkdirSync(join(repo, "proxy"), { recursive: true });
  writeFileSync(join(repo, ".env.defaults"), "AWS_REGION=us-east-1\n", "utf8");
  writeFileSync(join(repo, "secrets.env.defaults"), "AWS_BEARER_TOKEN_BEDROCK=aws-bedrock-api-key\n", "utf8");
  for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
    writeFileSync(join(repo, "proxy", `${file}.defaults`), "\n", "utf8");
  }
  return repo;
}

function stateJson(name: string, prefix: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    vmnetUuid: "00000000-0000-4000-8000-000000000001",
    subnet: `${prefix}.0`,
    networkPrefix: 24,
    firewallIp: `${prefix}.2`,
    agentIp: `${prefix}.3`,
    socketPath: `/private/var/run/rootcell/501/${name}.sock`,
    pidPath: `/private/var/run/rootcell/501/${name}.pid`,
  }, null, 2)}\n`;
}
