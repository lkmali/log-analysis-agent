/**
 * Maps low-level Postgres / network errors to a short, user-safe message.
 * Returns null when the error isn't a recognised database/connection failure.
 */
export function describeDbError(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  switch (code) {
    case "28P01": // invalid_password
    case "28000": // invalid_authorization_specification
      return "Database login failed. Check SQL_USER / SQL_PASSWORD in .env and restart the server.";
    case "3D000": // invalid_catalog_name
      return "Database not found. Check SQL_DATABASE in .env.";
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ECONNRESET":
      return "Can't reach the database server. Check SQL_HOST / SQL_PORT and that Postgres is running.";
    case "57P01": // admin_shutdown
    case "57P03": // cannot_connect_now
    case "53300": // too_many_connections
      return "The database is temporarily unavailable. Please try again shortly.";
    default:
      return null;
  }
}
