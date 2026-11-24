import { createHash } from "node:crypto";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { fromIni, fromTemporaryCredentials } from "@aws-sdk/credential-providers";

type Credentials = NonNullable<ConstructorParameters<typeof CloudWatchLogsClient>[0]>["credentials"];

const clients = new Map<string, CloudWatchLogsClient>();

/** Base credentials from Settings → AWS. All empty = default chain (EC2 instance role). */
export interface AwsBaseCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  profile?: string;
}

export function awsBaseCredentials(cfg: {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_PROFILE?: string;
}): AwsBaseCredentials {
  return {
    accessKeyId: cfg.AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY || undefined,
    profile: cfg.AWS_PROFILE || undefined,
  };
}

/** Static keys (both set) → named profile → undefined (SDK default chain / instance role). */
function resolveBase(b: AwsBaseCredentials): Credentials {
  if (b.accessKeyId && b.secretAccessKey) return { accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey };
  if (b.profile) return fromIni({ profile: b.profile });
  return undefined;
}

/** Cache-key fragment that changes when the credentials change, without holding the secret itself. */
function baseKey(b: AwsBaseCredentials) {
  if (b.accessKeyId && b.secretAccessKey) {
    const h = createHash("sha256").update(`${b.accessKeyId}:${b.secretAccessKey}`).digest("hex").slice(0, 16);
    return `keys:${h}`;
  }
  return b.profile ? `profile:${b.profile}` : "chain";
}

/**
 * One CloudWatch Logs client per (region, role, base credentials). Without a role ARN
 * the base credentials are used directly. With a role ARN the scheduler assumes it
 * (cross-account) with the stored ExternalId, using the base credentials to call STS.
 */
export function cloudWatchClient(
  region: string,
  roleArn?: string | null,
  externalId?: string | null,
  baseCreds: AwsBaseCredentials = {},
) {
  const key = `${region}|${roleArn ?? "direct"}|${baseKey(baseCreds)}`;
  let client = clients.get(key);
  if (!client) {
    const base = resolveBase(baseCreds);
    client = new CloudWatchLogsClient({
      region,
      maxAttempts: 5,
      retryMode: "adaptive", // client-side rate limiting on ThrottlingException
      credentials: roleArn
        ? fromTemporaryCredentials({
            params: {
              RoleArn: roleArn,
              RoleSessionName: "claude-sre-scheduler",
              DurationSeconds: 3600,
              ...(externalId ? { ExternalId: externalId } : {}),
            },
            clientConfig: { region },
            ...(base ? { masterCredentials: base } : {}),
          })
        : base,
    });
    clients.set(key, client);
  }
  return client;
}

export function destroyAwsClients() {
  for (const c of clients.values()) c.destroy();
  clients.clear();
}
