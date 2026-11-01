import { z } from "zod";

export const MAX_SPEC_CHARS = 25 * 1024 * 1024; // ~25 MB

export const uploadSpecSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((f) => /\.(json|ya?ml)$/i.test(f), "Only .json, .yaml, and .yml files are supported.")
    // The name is part of the stored file's path, so it must not add directories.
    .refine((f) => !/[/\\\p{Cc}]/u.test(f), "Use a plain file name, without folders."),
  content: z.string().min(1).max(MAX_SPEC_CHARS, "Spec exceeds the maximum allowed size."),
});

export type UploadSpecInput = z.infer<typeof uploadSpecSchema>;
