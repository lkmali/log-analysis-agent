import Anthropic from "@anthropic-ai/sdk";

let cached: { key: string | undefined; client: Anthropic } | undefined;

/**
 * Anthropic client for the API key saved on the Settings page. With no key saved,
 * the SDK falls back to its default credential chain (e.g. an `ant auth login` profile).
 * Re-created when the key changes.
 */
export function anthropic(apiKey: string | undefined): Anthropic {
  if (!cached || cached.key !== apiKey) {
    cached = { key: apiKey, client: apiKey ? new Anthropic({ apiKey }) : new Anthropic() };
  }
  return cached.client;
}
