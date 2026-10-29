import { z } from "zod";

import { decodePluginSecretEncryptionKey } from "~/lib/plugin-secret-key.server";

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().url().optional(),
);

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.string().optional(),
);

const envSchema = z.object({
  APP_URL: z.string().url().default("http://localhost:3000"),
  ATTACHMENT_PDF_COMPRESSION: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.enum(["off", "150dpi", "200dpi"]).default("200dpi"),
  ),
  COOKIE_NAME: z.string().default("clinic_token"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  API_DRY_RUN: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.trim().toLowerCase() === "true"
        : value,
    z.boolean().default(false),
  ),
  FHIR_TEST_DELETE_ENABLED: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.trim().toLowerCase() === "true"
        : value,
    z.boolean().default(false),
  ),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.trim().toLowerCase() === "true"
        : value,
    z.boolean().default(false),
  ),
  S3_REGION: z.string().default("us-east-1"),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  DOCS_APP_BASE_URL: optionalUrl,
  DOCS_WEBHOOK_BASE_URL: optionalUrl,
  MEUEXAME_API_BASE_URL: optionalUrl,
  PLUGIN_SECRET_ENCRYPTION_KEY: optionalString,
}).superRefine((value, context) => {
  if (!value.MEUEXAME_API_BASE_URL && !value.DOCS_APP_BASE_URL) {
    return;
  }

  if (!value.PLUGIN_SECRET_ENCRYPTION_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "PLUGIN_SECRET_ENCRYPTION_KEY is required when plugin integrations are configured.",
      path: ["PLUGIN_SECRET_ENCRYPTION_KEY"],
    });
    return;
  }

  if (!decodePluginSecretEncryptionKey(value.PLUGIN_SECRET_ENCRYPTION_KEY)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "PLUGIN_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key or a 64-character hex key.",
      path: ["PLUGIN_SECRET_ENCRYPTION_KEY"],
    });
  }
});

export const env = envSchema.parse(process.env);

if (env.API_DRY_RUN) {
  console.warn(
    "[DRY RUN] API_DRY_RUN=true — FHIR API writes are stored in memory only. Data will be lost on restart.",
  );
}
