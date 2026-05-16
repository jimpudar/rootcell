import { z } from "zod";

export const EnvironmentVariableNameSchema = z.string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name");

export const NonEmptyStringSchema = z.string().min(1, "must be a non-empty string");

export const NonNegativeSafeIntegerSchema = z.number()
  .int("must be an integer")
  .nonnegative("must be non-negative")
  .refine(Number.isSafeInteger, "must be a safe integer");

export const PositiveSafeIntegerSchema = z.number()
  .int("must be an integer")
  .positive("must be positive")
  .refine(Number.isSafeInteger, "must be a safe integer");

export function parseSchema<TOutput>(schema: z.ZodType<TOutput>, raw: unknown, context: string): TOutput {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  throw new Error(`${context}: ${zodErrorMessage(result.error)}`);
}

export function zodErrorMessage(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  }).join("; ");
}
