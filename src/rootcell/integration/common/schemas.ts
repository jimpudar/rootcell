import { z } from "zod";
import { NonEmptyStringSchema } from "../../schema.ts";

export const VmListEntrySchema = z.object({
  instance: NonEmptyStringSchema,
  vm: NonEmptyStringSchema,
  state: NonEmptyStringSchema,
}).strict();

export const CommandOutputSchema = z.object({
  status: z.literal(0),
  stdout: z.string(),
  stderr: z.string(),
}).strict();
