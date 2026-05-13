#!/usr/bin/env bun
import { rootcellMain } from "../rootcell/rootcell.ts";

const status = await rootcellMain(process.argv.slice(2), import.meta.path);
process.exit(status);
