#!/usr/bin/env bun
import { runIntegrationCli } from "../rootcell/integration/common/lifecycle.ts";

process.exit(await runIntegrationCli(process.argv.slice(2), import.meta.url));
