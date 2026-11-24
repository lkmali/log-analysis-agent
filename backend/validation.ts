import { z } from "zod";

/** Shared request contracts for Vercel write routes and server actions. */

export const orgSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "3–50 chars: lowercase letters, numbers, hyphens");

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: orgSlugSchema,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

const githubName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, "Invalid GitHub name");

/** Commands are restricted to a conservative allowlist of package-manager scripts (plan §12). */
export const testCommandSchema = z
  .string()
  .trim()
  .regex(
    /^(npm|pnpm|yarn) (ci|install|test|run [A-Za-z0-9:_-]+)$/,
    "Only npm/pnpm/yarn ci|install|test|run <script> are allowed",
  );

export const registerRepositorySchema = z.object({
  organizationId: z.string().uuid(),
  owner: githubName,
  name: githubName,
  defaultBranch: z.string().trim().min(1).max(255).default("main"),
  installationId: z.number().int().positive().optional(),
  technology: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  services: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  testCommands: z.array(testCommandSchema).max(10).default([]),
  prPolicy: z.enum(["draft_only", "approval_required"]).default("approval_required"),
});
export type RegisterRepositoryInput = z.infer<typeof registerRepositorySchema>;

export const updateRepositorySchema = z.object({
  enabled: z.boolean(),
});
export type UpdateRepositoryInput = z.infer<typeof updateRepositorySchema>;

export const awsRegionSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2}(-[a-z]+)+-[0-9]$/, "Invalid AWS region, e.g. ap-south-1");

/** CloudWatch log group names: 1–512 chars of [.-_/#A-Za-z0-9]. */
export const logGroupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[.\-_/#A-Za-z0-9]+$/, "Invalid CloudWatch log group name");

export const addCloudWatchSourceSchema = z.object({
  organizationId: z.string().uuid(),
  region: awsRegionSchema,
  /** Single group (manual entry). Either this or `logGroups` must be set. */
  logGroup: logGroupNameSchema.optional(),
  /** Several groups picked from the AWS browser; all get the same settings. */
  logGroups: z.array(logGroupNameSchema).max(500).optional(),
  serviceName: z.string().trim().max(100).default(""),
  environment: z.string().trim().max(50).default(""),
  ingestMode: z.enum(["errors_only", "all"]).default("errors_only"),
  filterPattern: z.string().trim().max(1024).default(""),
  piiScan: z.boolean().default(true),
  pollIntervalSeconds: z.number().int().min(15).max(3600).default(60),
  awsAccountId: z.string().uuid().optional(),
}).refine((v) => !!v.logGroup || !!v.logGroups?.length, {
  message: "Pick at least one log group", path: ["logGroups"],
});
export type AddCloudWatchSourceInput = z.infer<typeof addCloudWatchSourceSchema>;

/** List the log groups that exist in an AWS account/region (Add log group → Browse AWS). */
export const discoverLogGroupsSchema = z.object({
  organizationId: z.string().uuid(),
  region: awsRegionSchema,
  awsAccountId: z.string().uuid().optional(),
  prefix: z.string().trim().max(512).regex(/^[.\-_/#A-Za-z0-9]*$/, "Invalid prefix").default(""),
});

export const updateLogSourceSchema = z.object({
  serviceName: z.string().trim().max(100).default(""),
  environment: z.string().trim().max(50).default(""),
  ingestMode: z.enum(["errors_only", "all"]),
  filterPattern: z.string().trim().max(1024).default(""),
  piiScan: z.boolean(),
  pollIntervalSeconds: z.number().int().min(15).max(3600),
  enabled: z.boolean(),
});

export const toggleSchema = z.object({ enabled: z.boolean() });

export const alertStatusSchema = z.enum(["open", "acknowledged", "resolved"]);
export const updateAlertSchema = z.object({ status: alertStatusSchema });

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

export const incidentStatusSchema = z.enum([
  "new",
  "investigating",
  "needs_review",
  "resolved",
  "ignored",
]);
