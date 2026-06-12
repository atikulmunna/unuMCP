import { z } from "zod";

const MAX_SPEC_CHARS = 25 * 1024 * 1024; // ~25 MB

export const uploadSpecSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((f) => /\.(json|ya?ml)$/i.test(f), "Only .json, .yaml, and .yml files are supported."),
  content: z.string().min(1).max(MAX_SPEC_CHARS, "Spec exceeds the maximum allowed size."),
});

export type UploadSpecInput = z.infer<typeof uploadSpecSchema>;
