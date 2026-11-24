"use client";

import { useActionState } from "react";
import { signIn, type AuthState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<AuthState, FormData>(signIn, {});

  return (
    <form action={action} className="stack">
      <input type="hidden" name="next" value={next ?? ""} />
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" minLength={10} required />
      </label>
      {state.error && <p className="error">{state.error}</p>}
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Please wait…" : "Sign in"}
      </button>
      <p className="muted" style={{ margin: 0 }}>Need an account? Ask a superadmin.</p>
    </form>
  );
}
