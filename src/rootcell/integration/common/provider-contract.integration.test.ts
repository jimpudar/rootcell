import { beforeAll, describe, test } from "vitest";
import {
  expectDnsPolicy,
  expectFirewallServices,
  expectGuestTools,
  expectHttpsRequestRegexPolicy,
  expectPrivateNetworkRouting,
  expectProviderNeutralVmList,
  expectProxyPolicy,
  expectSpyWiring,
  expectSshPolicy,
} from "./assertions.ts";
import { createProvisionedSelectedIntegrationFlow, type IntegrationFlow } from "./rootcell-flow.ts";

let flow: IntegrationFlow;

describe("provider contract integration flow", { concurrent: false }, () => {
  beforeAll(async () => {
    flow = await createProvisionedSelectedIntegrationFlow(import.meta.url);
  });

  test("reports provider-neutral VM list state", async () => {
    await expectProviderNeutralVmList(flow);
  });

  test("restarts stopped VMs through the rootcell flow", async () => {
    await flow.restartThroughRootcellWrapper();
  });

  test("has firewall services and spy tooling wired", async () => {
    await expectFirewallServices(flow);
    await expectSpyWiring(flow);
  });

  test("routes private agent traffic through the firewall", async () => {
    await expectPrivateNetworkRouting(flow);
  });

  test("installs expected guest development tools", async () => {
    await expectGuestTools(flow);
  });

  test("enforces HTTPS proxy policy", async () => {
    await expectProxyPolicy(flow);
  });

  test("enforces HTTPS request regex policy", async () => {
    await expectHttpsRequestRegexPolicy(flow);
  });

  test("enforces DNS policy", async () => {
    await expectDnsPolicy(flow);
  });

  test("enforces SSH policy", async () => {
    await expectSshPolicy(flow);
  });
});
