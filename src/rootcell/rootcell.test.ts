import { describe, expect, test } from "bun:test";
import { parseRootcellArgs, parseSpyOptions } from "./args.ts";
import { ROOTCELL_SUBCOMMANDS } from "./metadata.ts";
import { loadDotEnv, parseSecretMappings } from "./env.ts";
import { buildConfig } from "./rootcell.ts";
import { dnsmasqAllowlistConfig, generatedLineCount } from "../bin/reload.ts";
import { readFileSync, writeFileSync } from "node:fs";

describe("rootcell argument parsing", () => {
  test("parses known subcommands and leaves pass-through args intact", () => {
    expect(parseRootcellArgs(["provision", "ignored"])).toEqual({
      subcommand: "provision",
      rest: ["ignored"],
    });
    expect(parseRootcellArgs(["--", "nix", "flake", "update"])).toEqual({
      subcommand: "",
      rest: ["--", "nix", "flake", "update"],
    });
  });

  test("parses spy flags", () => {
    expect(parseSpyOptions(["--tui", "--raw", "--no-dedupe"])).toEqual({
      raw: true,
      dedupe: false,
      tui: true,
    });
  });

  test("rejects unknown spy flags", () => {
    expect(() => parseSpyOptions(["--bogus"])).toThrow("unknown spy option");
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

  test("builds defaults with typed config fields", () => {
    expect(buildConfig("/repo", {}).firewallIp).toBe("192.168.106.2");
    expect(buildConfig("/repo", { LIMA_NETWORK: "host2" }).limaNetwork).toBe("host2");
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
  test("bash and zsh completions include all typed subcommands", () => {
    const bash = readFileSync("completions/rootcell.bash", "utf8");
    const zsh = readFileSync("completions/rootcell.zsh", "utf8");
    for (const subcommand of ROOTCELL_SUBCOMMANDS) {
      expect(bash).toContain(subcommand.name);
      expect(zsh).toContain(subcommand.name);
    }
  });
});
