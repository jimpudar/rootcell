import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseRootcellArgs } from "./args.ts";
import { ROOTCELL_SUBCOMMANDS } from "./metadata.ts";
import { loadDotEnv, parseSecretMappings } from "./env.ts";
import { resolveHostTool } from "./host-tools.ts";
import { buildConfig, formatVmList } from "./rootcell.ts";
import { deriveVmNames, listRootcellVmInstanceNames, loadRootcellInstance, seedRootcellInstanceFiles } from "./instance.ts";
import { runCapture } from "./process.ts";
import { createProviderBundle } from "./providers/factory.ts";
import { getMacAddressFor, MacOsVfkitNetworkProvider } from "./providers/macos-vfkit-network.ts";
import { vfkitArgs, parseVfkitVmState, lookupDhcpLease, vfkitCloudInitUserData } from "./providers/vfkit.ts";
import {
  ImageStore,
  imageDownloadUrl,
  parseRootcellImageManifest,
  imageForRole,
  ROOTCELL_GUEST_API_VERSION,
  ROOTCELL_IMAGE_SCHEMA_VERSION,
  RootcellImageManifestSchema,
} from "./images.ts";
import { forgetKnownHost, sshConfig } from "./transports/proxyjump-ssh.ts";
import { dnsmasqAllowlistConfig, generatedLineCount } from "../bin/reload.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ParsedRootcellRunArgsSchema,
  RootcellConfigSchema,
  RootcellInstanceSchema,
  SecretMappingSchema,
  type ParsedRootcellRunArgs,
  type RootcellInstance,
} from "./types.ts";

const EmptyStringArraySchema = z.array(z.string()).length(0);
const DefaultSpyOptionsSchema = z.object({
  raw: z.literal(false),
  dedupe: z.literal(true),
  tui: z.literal(false),
}).strict();

const ignoreLog = (): void => undefined;

function expectRunArgs(value: ParsedRootcellRunArgs): void {
  expect(value).toEqual(expect.schemaMatching(ParsedRootcellRunArgsSchema));
}

describe("rootcell argument parsing", () => {
  test("parses known subcommands", () => {
    const parsed = runArgs(["provision"]);
    expectRunArgs(parsed);
    expect(parsed.rest).toEqual(expect.schemaMatching(EmptyStringArraySchema));
    expect(parsed.spyOptions).toEqual(expect.schemaMatching(DefaultSpyOptionsSchema));
    expect(parsed).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "provision",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    expect(() => parseRootcellArgs(["provision", "ignored"])).toThrow("Too many non-option arguments");
  });

  test("parses lifecycle subcommands", () => {
    const list = runArgs(["list"]);
    expectRunArgs(list);
    expect(list).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "list",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const stop = runArgs(["stop", "--instance", "dev"]);
    expectRunArgs(stop);
    expect(stop).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "stop",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const remove = runArgs(["remove", "--instance=dev"]);
    expectRunArgs(remove);
    expect(remove).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "remove",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
  });

  test("parses pass-through guest commands", () => {
    const explicit = runArgs(["--", "nix", "flake", "update"]);
    expectRunArgs(explicit);
    expect(explicit).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "",
      rest: ["nix", "flake", "update"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const implicit = runArgs(["pi", "--model", "sonnet"]);
    expectRunArgs(implicit);
    expect(implicit).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "",
      rest: ["pi", "--model", "sonnet"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
  });

  test("parses instance flags in any command position", () => {
    const beforeCommand = runArgs(["--instance", "dev", "provision"]);
    expectRunArgs(beforeCommand);
    expect(beforeCommand).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "provision",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const afterCommand = runArgs(["allow", "--instance=dev"]);
    expectRunArgs(afterCommand);
    expect(afterCommand).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "allow",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const passThrough = runArgs(["pi", "--instance", "dev", "--model", "sonnet"]);
    expectRunArgs(passThrough);
    expect(passThrough).toEqual({
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
    const parsed = runArgs(["spy", "--tui", "--raw", "--no-dedupe"]);
    expectRunArgs(parsed);
    expect(parsed).toEqual({
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
    const mappings = parseSecretMappings("AWS_BEARER_TOKEN_BEDROCK=aws-bedrock-api-key\n");
    expect(mappings).toEqual(expect.schemaMatching(z.array(SecretMappingSchema)));
    expect(mappings).toEqual([
      { envName: "AWS_BEARER_TOKEN_BEDROCK", service: "aws-bedrock-api-key" },
    ]);
    expect(() => parseSecretMappings("1BAD=service\n")).toThrow("invalid secret environment variable name");
    expect(() => parseSecretMappings("BAD\n")).toThrow("invalid secret entry");
    expect(() => parseSecretMappings("BAD=\n")).toThrow("empty Keychain service name");
  });

  test("builds config from instance state", () => {
    const instance = fakeInstance("dev");
    expect(instance).toEqual(expect.schemaMatching(RootcellInstanceSchema));
    const config = buildConfig("/repo", {}, instance);
    expect(config).toEqual(expect.schemaMatching(RootcellConfigSchema));
    expect(config.agentVm).toBe("agent-dev");
    expect(config.firewallVm).toBe("firewall-dev");
    expect(config.firewallIp).toBe("192.168.109.2");
    expect(config.agentIp).toBe("192.168.109.3");
    expect(config.imageManifestUrl).toBe("https://github.com/rootcell-ai/rootcell/releases/latest/download/manifest.json");
  });
});

describe("host tool resolution", () => {
  const vfkitSpec = {
    name: "vfkit",
    envVar: "ROOTCELL_VFKIT",
    purpose: "to start test VMs",
  };

  test("prefers explicit environment overrides", () => {
    expect(resolveHostTool(vfkitSpec, {
      env: { ROOTCELL_VFKIT: "/opt/rootcell/bin/vfkit" },
      commandExists: () => false,
    })).toBe("/opt/rootcell/bin/vfkit");
  });

  test("uses PATH before asking the user to install anything", () => {
    expect(resolveHostTool(vfkitSpec, {
      env: {},
      commandExists: (command) => command === "vfkit",
    })).toBe("vfkit");
  });

  test("missing tools produce package-manager instructions", () => {
    expect(() => resolveHostTool(vfkitSpec, {
      env: {},
      commandExists: () => false,
    })).toThrow("brew install bun vfkit zstd python");
    expect(() => resolveHostTool(vfkitSpec, {
      env: {},
      commandExists: () => false,
    })).toThrow("nix shell .#hostTools --command ./rootcell");
  });

  test("runtime host tools do not fall back to host-side nix builds", () => {
    for (const file of [
      "src/rootcell/images.ts",
      "src/rootcell/providers/vfkit.ts",
      "src/rootcell/providers/macos-vfkit-network.ts",
    ]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/run(?:Capture|Inherited)\("nix"/);
    }
  });
});

describe("VM and network providers", () => {
  test("factory defaults to vfkit providers", () => {
    const providers = createProviderBundle(buildConfig("/repo", {}, fakeInstance("dev")), ignoreLog);
    expect(providers.network.id).toBe("macos-vfkit");
    expect(providers.vm.id).toBe("vfkit");
  });

  test("macOS vfkit provider exposes host-control and hostless-private attachments", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const plan = new MacOsVfkitNetworkProvider(config, ignoreLog).plan();
    expect(plan).toEqual(expect.schemaMatching(z.object({
      provider: z.literal("macos-vfkit"),
      guest: z.object({
        firewallIp: z.literal("192.168.109.2"),
        agentIp: z.literal("192.168.109.3"),
        networkPrefix: z.literal(24),
        agentPrivateInterface: z.literal("enp0s1"),
        firewallPrivateInterface: z.literal("enp0s2"),
        firewallEgressInterface: z.literal("enp0s1"),
        firewallControlInterface: z.literal("enp0s1"),
      }).strict(),
      vms: z.object({
        agent: z.object({
          kind: z.literal("vfkit"),
          role: z.literal("agent"),
          privateMac: z.string().regex(/^52:54:00:/),
          privateSocketPath: z.string(),
          useNat: z.literal(false),
        }).strict(),
        firewall: z.object({
          kind: z.literal("vfkit"),
          role: z.literal("firewall"),
          privateMac: z.string().regex(/^52:54:00:/),
          privateSocketPath: z.string(),
          controlMac: z.string().regex(/^52:54:00:/),
          useNat: z.literal(true),
        }).strict(),
      }).strict(),
    }).strict()));
    expect(plan.provider).toBe("macos-vfkit");
    expect(plan.guest).toEqual({
      firewallIp: "192.168.109.2",
      agentIp: "192.168.109.3",
      networkPrefix: 24,
      agentPrivateInterface: "enp0s1",
      firewallPrivateInterface: "enp0s2",
      firewallEgressInterface: "enp0s1",
      firewallControlInterface: "enp0s1",
    });
    expect(plan.vms.agent.kind).toBe("vfkit");
    expect(plan.vms.agent.useNat).toBe(false);
    expect(plan.vms.firewall.useNat).toBe(true);
    expect(plan.vms.firewall.controlMac).toMatch(/^52:54:00:/);
    expect(plan.vms.agent.privateSocketPath).toContain("/repo/.rootcell/instances/dev/vfkit/network/agent-private.sock");
    expect(plan.vms.firewall.privateSocketPath).toContain("/repo/.rootcell/instances/dev/vfkit/network/firewall-private.sock");
  });

  test("vfkit MACs are stable per repo instance and distinct across worktrees", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const otherWorktree = buildConfig("/other-repo", {}, fakeInstance("dev"));

    expect(getMacAddressFor(config, "firewall", "control")).toBe(getMacAddressFor(config, "firewall", "control"));
    expect(getMacAddressFor(config, "firewall", "control")).not.toBe(getMacAddressFor(otherWorktree, "firewall", "control"));
  });

  test("vfkit args include EFI, cloud-init, expected NICs, and no VSOCK", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const network = new MacOsVfkitNetworkProvider(config, ignoreLog).plan().vms.firewall;
    const args = vfkitArgs({
      role: "firewall",
      diskPath: "/vm/firewall/disk.raw",
      efiVariableStorePath: "/vm/firewall/efi",
      restSocketPath: "/vm/firewall/rest.sock",
      logPath: "/vm/firewall/serial.log",
      cloudInitDir: "/vm/firewall/cloud-init",
      network,
    });
    expect(args).toContain("efi,variable-store=/vm/firewall/efi,create");
    expect(args).toContain(`virtio-net,nat,mac=${network.controlMac ?? ""}`);
    expect(args).toContain("virtio-net,unixSocketPath=" + network.privateSocketPath + ",mac=" + network.privateMac);
    expect(args.join(" ")).toContain("--cloud-init /vm/firewall/cloud-init/user-data,/vm/firewall/cloud-init/meta-data");
    expect(args.join(" ")).not.toContain("vsock");
  });

  test("vfkit cloud-init configures role private addresses before SSH", () => {
    const agent = vfkitCloudInitUserData({
      role: "agent",
      user: "luser",
      publicKey: "ssh-ed25519 test",
      instanceName: "dev",
      firewallIp: "192.168.109.2",
      agentIp: "192.168.109.3",
      networkPrefix: "24",
      privateMac: "52:54:00:4e:1d:de",
    });
    expect(agent).toContain("for path in /sys/class/net/*");
    expect(agent).toContain("MACAddress=52:54:00:4e:1d:de");
    expect(agent).toContain("lock_passwd: false");
    expect(agent).toContain("hashed_passwd:");
    expect(agent).toContain("addr='192.168.109.3/24'");
    expect(agent).toContain("ip route replace default via \"$gateway\"");
    expect(agent).toContain("printf 'nameserver %s\\n' \"$gateway\" > /etc/resolv.conf");

    const firewall = vfkitCloudInitUserData({
      role: "firewall",
      user: "luser",
      publicKey: "ssh-ed25519 test",
      instanceName: "dev",
      firewallIp: "192.168.109.2",
      agentIp: "192.168.109.3",
      networkPrefix: "24",
      privateMac: "52:54:00:c4:80:73",
    });
    expect(firewall).toContain("MACAddress=52:54:00:c4:80:73");
    expect(firewall).toContain("addr='192.168.109.2/24'");
  });

  test("proxyjump ssh config uses direct firewall and jumped agent aliases", () => {
    const configText = sshConfig({
      user: "luser",
      firewallHost: "192.168.64.10",
      agentHost: "192.168.109.3",
      identityPath: "/instance/ssh/rootcell_control_ed25519",
      knownHostsPath: "/instance/ssh/known_hosts",
      controlPath: "/tmp/rootcell-ssh-test/%C",
    });
    expect(configText).toContain("Host rootcell-firewall");
    expect(configText).toContain("HostName 192.168.64.10");
    expect(configText).toContain("Host rootcell-agent");
    expect(configText).toContain("ProxyJump rootcell-firewall");
    expect(configText).toContain("IdentityFile /instance/ssh/rootcell_control_ed25519");
    expect(configText).toContain("BatchMode yes");
    expect(configText).toContain("PasswordAuthentication no");
    expect(configText).toContain("KbdInteractiveAuthentication no");
    expect(configText).toContain("ControlMaster auto");
    expect(configText).toContain("ControlPersist 60s");
    expect(configText).toContain("ControlPath /tmp/rootcell-ssh-test/%C");
  });

  test("proxyjump known_hosts removal clears only the rotated VM host", () => {
    const dir = mkdtempSync(join(tmpdir(), "rootcell-known-hosts-"));
    try {
      const path = join(dir, "known_hosts");
      writeFileSync(path, [
        "192.168.64.12 ssh-ed25519 firewall",
        "192.168.109.3 ssh-ed25519 old-agent",
        "[192.168.109.3]:22 ssh-ed25519 bracketed-agent",
        "github.com ssh-ed25519 github",
        "",
      ].join("\n"));

      forgetKnownHost(path, "192.168.109.3");

      const content = readFileSync(path, "utf8");
      expect(content).toContain("192.168.64.12 ssh-ed25519 firewall");
      expect(content).not.toContain("old-agent");
      expect(content).not.toContain("bracketed-agent");
      expect(content).toContain("github.com ssh-ed25519 github");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("vfkit state parser validates running state shape", () => {
    const state = parseVfkitVmState({
      provider: "vfkit",
      name: "firewall-dev",
      role: "firewall",
      pid: 123,
      diskPath: "/vm/disk.raw",
      efiVariableStorePath: "/vm/efi",
      restSocketPath: "/vm/rest.sock",
      logPath: "/vm/serial.log",
      privateMac: "52:54:00:00:00:01",
      controlMac: "52:54:00:00:00:02",
      firewallControlIp: "192.168.64.2",
    });
    expect(state).toEqual(expect.schemaMatching(z.object({
      provider: z.literal("vfkit"),
      name: z.literal("firewall-dev"),
      role: z.literal("firewall"),
      pid: z.literal(123),
      diskPath: z.literal("/vm/disk.raw"),
      efiVariableStorePath: z.literal("/vm/efi"),
      restSocketPath: z.literal("/vm/rest.sock"),
      logPath: z.literal("/vm/serial.log"),
      privateMac: z.literal("52:54:00:00:00:01"),
      controlMac: z.literal("52:54:00:00:00:02"),
      firewallControlIp: z.literal("192.168.64.2"),
    }).strict()));
    expect(state.firewallControlIp).toBe("192.168.64.2");
    expect(() => parseVfkitVmState({ provider: "unknown" })).toThrow("provider mismatch");
  });

  test("macOS DHCP lease parser finds vfkit NAT IP by MAC", () => {
    const repo = makeInstanceRepo();
    const leases = join(repo, "leases");
    try {
      writeFileSync(leases, [
        "name=firewall-vm",
        "ip_address=192.168.64.8",
        "hw_address=ff,not-the-mac",
        "lease=0x1",
        "",
        "name=firewall",
        "ip_address=192.168.64.9",
        "hw_address=1,52:54:00:aa:bb:cc",
        "",
        "name=firewall-vm",
        "ip_address=192.168.64.10",
        "hw_address=ff,still-not-the-mac",
        "lease=0x2",
        "",
      ].join("\n"), "utf8");
      expect(lookupDhcpLease("52:54:00:aa:bb:cc", leases)).toBe("192.168.64.9");
      expect(lookupDhcpLease("52:54:00:00:00:00", leases, "firewall-vm")).toBe("192.168.64.10");
      expect(lookupDhcpLease("52:54:00:00:00:00", leases)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("formats VM state list", () => {
    expect(formatVmList([
      { instance: "default", vm: "agent", state: "running" },
      { instance: "dev", vm: "firewall-dev", state: "stopped" },
    ])).toBe([
      "INSTANCE  VM            STATE",
      "default   agent         running",
      "dev       firewall-dev  stopped",
      "",
    ].join("\n"));
    expect(formatVmList([])).toBe("No rootcell VMs found.\n");
  });
});

describe("rootcell image manifest contract", () => {
  test("parses compatible manifest and selects role images", () => {
    const manifest = parseRootcellImageManifest(fakeManifest());
    expect(manifest).toEqual(expect.schemaMatching(RootcellImageManifestSchema));
    expect(manifest.schemaVersion).toBe(ROOTCELL_IMAGE_SCHEMA_VERSION);
    expect(manifest.guestApiVersion).toBe(ROOTCELL_GUEST_API_VERSION);
    expect(imageForRole(manifest, "agent").fileName).toBe("agent.raw.zst");
  });

  test("resolves relative image asset URLs against the manifest URL", () => {
    expect(imageDownloadUrl(
      "agent.raw.zst",
      "https://github.com/rootcell-ai/rootcell/releases/download/guest-v1/manifest.json",
    )).toBe("https://github.com/rootcell-ai/rootcell/releases/download/guest-v1/agent.raw.zst");
    expect(imageDownloadUrl(
      "https://downloads.example/rootcell/agent.raw.zst",
      "https://github.com/rootcell-ai/rootcell/releases/download/guest-v1/manifest.json",
    )).toBe("https://downloads.example/rootcell/agent.raw.zst");
  });

  test("rejects incompatible guest API and CLI contract", () => {
    expect(() => parseRootcellImageManifest({ ...fakeManifest(), guestApiVersion: 99 })).toThrow("guestApiVersion");
    const missingContract = fakeManifest();
    delete missingContract.rootcellCliContract;
    expect(() => parseRootcellImageManifest(missingContract)).toThrow("rootcellCliContract");
    expect(() => parseRootcellImageManifest({
      ...fakeManifest(),
      rootcellCliContract: { min: 2, max: 2 },
    })).toThrow("CLI image contract");
  });

  test("caches parsed manifests by image source", () => {
    const repo = makeInstanceRepo();
    const imageDir = join(repo, "images");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, "manifest.json"), `${JSON.stringify(fakeManifest())}\n`, "utf8");
    try {
      const config = buildConfig("/repo", { ROOTCELL_IMAGE_DIR: imageDir }, fakeInstance("dev"));
      expect(new ImageStore(config, ignoreLog).loadManifest().rootcellSourceRevision).toBe("abc123");
      writeFileSync(join(imageDir, "manifest.json"), `${JSON.stringify({
        ...fakeManifest(),
        guestApiVersion: 99,
      })}\n`, "utf8");
      expect(new ImageStore(config, ignoreLog).loadManifest().rootcellSourceRevision).toBe("abc123");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
      expect(defaultInstance).toEqual(expect.schemaMatching(RootcellInstanceSchema));

      seedRootcellInstanceFiles(repo, "dev", ignoreLog);
      const envB: NodeJS.ProcessEnv = {};
      loadDotEnv(join(repo, ".rootcell/instances/dev/.env"), envB);
      const devInstance = loadRootcellInstance(repo, "dev", envB);
      expect(devInstance).toEqual(expect.schemaMatching(RootcellInstanceSchema));

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

  test("lists only instances with vfkit VM state", () => {
    const repo = makeInstanceRepo();
    try {
      mkdirSync(join(repo, ".rootcell/instances/default"), { recursive: true });
      mkdirSync(join(repo, ".rootcell/instances/dev/vfkit/agent-dev"), { recursive: true });
      writeFileSync(join(repo, ".rootcell/instances/default/state.json"), stateJson("default", "192.168.100"), "utf8");
      writeFileSync(join(repo, ".rootcell/instances/dev/state.json"), stateJson("dev", "192.168.101"), "utf8");

      expect(listRootcellVmInstanceNames(repo)).toEqual(["dev"]);
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

  test("generates dnsmasq catch-all entry from wildcard line", () => {
    const config = dnsmasqAllowlistConfig("  *  \n");
    expect(config).toBe("server=/#/1.1.1.1\n");
    expect(generatedLineCount(config)).toBe(1);
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
      subnet: "192.168.109.0",
      networkPrefix: 24,
      firewallIp: "192.168.109.2",
      agentIp: "192.168.109.3",
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
    subnet: `${prefix}.0`,
    networkPrefix: 24,
    firewallIp: `${prefix}.2`,
    agentIp: `${prefix}.3`,
  }, null, 2)}\n`;
}

function fakeManifest(): Record<string, unknown> {
  const image = {
    role: "agent",
    architecture: "aarch64-linux",
    fileName: "agent.raw.zst",
    url: "https://example.invalid/agent.raw.zst",
    compression: "zstd",
    compressedSize: 100,
    rawSize: 1000,
    sha256: "0".repeat(64),
  };
  return {
    schemaVersion: ROOTCELL_IMAGE_SCHEMA_VERSION,
    guestApiVersion: ROOTCELL_GUEST_API_VERSION,
    rootcellSourceRevision: "abc123",
    nixpkgsRevision: "def456",
    rootcellCliContract: { min: 1, max: 1 },
    images: [
      image,
      { ...image, role: "firewall", fileName: "firewall.raw.zst", url: "https://example.invalid/firewall.raw.zst" },
      { ...image, role: "builder", fileName: "builder.raw.zst", url: "https://example.invalid/builder.raw.zst" },
    ],
  };
}
