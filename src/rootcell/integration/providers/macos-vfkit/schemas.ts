import { z } from "zod";
import { NonEmptyStringSchema, PositiveSafeIntegerSchema } from "../../../schema.ts";

const MacAddressSchema = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);

export const VfkitVmStateFileSchema = z.object({
  provider: z.literal("vfkit"),
  name: NonEmptyStringSchema,
  role: z.enum(["agent", "firewall"]),
  pid: PositiveSafeIntegerSchema,
  diskPath: NonEmptyStringSchema,
  efiVariableStorePath: NonEmptyStringSchema,
  restSocketPath: NonEmptyStringSchema,
  logPath: NonEmptyStringSchema,
  privateMac: MacAddressSchema,
  controlMac: MacAddressSchema.optional(),
  firewallControlIp: NonEmptyStringSchema.optional(),
}).strict();

export const VfkitPrivateLinkStateFileSchema = z.object({
  pid: PositiveSafeIntegerSchema,
  firewallSocketPath: NonEmptyStringSchema,
  agentSocketPath: NonEmptyStringSchema,
}).strict();

export const VfkitNetworkAttachmentSchema = z.object({
  kind: z.literal("vfkit"),
  role: z.enum(["agent", "firewall"]),
  privateMac: MacAddressSchema,
  privateSocketPath: NonEmptyStringSchema,
  controlMac: MacAddressSchema.optional(),
  useNat: z.boolean(),
}).strict();
