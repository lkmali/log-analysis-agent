import "server-only";

import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { getSessionUser } from "./auth";

export async function requireApiUser() {
  return getSessionUser();
}

export function jsonError(status: number, message: string, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status });
}

export function validationError(error: ZodError) {
  return jsonError(400, "Invalid request", error.flatten());
}

/** Maps PostgreSQL errors from app.* functions to HTTP responses without leaking internals. */
export function databaseError(error: unknown) {
  const e = error as { code?: string; message?: string };
  switch (e.code) {
    case "42501":
      return jsonError(403, e.message ?? "Not permitted");
    case "23505":
      return jsonError(409, "Already exists");
    case "23514":
    case "22P02":
      return jsonError(400, "Invalid value");
    default:
      console.error(JSON.stringify({ level: "error", msg: "database error", code: e.code, error: e.message }));
      return jsonError(500, "Database error");
  }
}
