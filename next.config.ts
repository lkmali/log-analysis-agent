import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node-only libraries used by the backend/scheduler; load them from node_modules instead of bundling.
  serverExternalPackages: ["pg", "nodemailer", "@aws-sdk/client-cloudwatch-logs", "@aws-sdk/credential-providers", "@anthropic-ai/sdk"],
  poweredByHeader: false,
  output: "standalone", // run on any Node host with `node .next/standalone/server.js`
};

export default nextConfig;
