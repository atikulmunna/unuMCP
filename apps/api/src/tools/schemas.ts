import { z } from "zod";

export const updateToolSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "Tool names must be snake_case (lowercase, start with a letter).")
      .optional(),
    description: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "No fields to update");

export type UpdateToolInput = z.infer<typeof updateToolSchema>;
