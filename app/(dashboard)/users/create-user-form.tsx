"use client";

import { useActionState, useEffect, useRef } from "react";
import { createUserAction, type CreateUserState } from "./actions";

export function CreateUserForm({ orgs, activeOrgId }: { orgs: { id: string; name: string }[]; activeOrgId: string }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(createUserAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="card stack" style={{ maxWidth: 760 }}>
      <div>
        <h2 style={{ marginBottom: 2 }}>Add user</h2>
        <p className="muted" style={{ margin: 0 }}>Only superadmins can create accounts. There is no public sign-up.</p>
      </div>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="off" required />
      </label>
      <label className="field">
        <span>Display name (optional)</span>
        <input name="displayName" type="text" maxLength={100} autoComplete="off" />
      </label>
      <label className="field">
        <span>Initial password</span>
        <input name="password" type="password" autoComplete="new-password" minLength={10} required />
      </label>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>Organization</span>
          <select name="organizationId" defaultValue={activeOrgId}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
            <option value="">None (user creates their own)</option>
          </select>
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Role</span>
          <select name="role" defaultValue="member">
            <option value="viewer">Viewer</option>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </label>
      </div>
      <label className="row" style={{ gap: 8 }}>
        <input name="superadmin" type="checkbox" />
        <span>Superadmin (can add users and change platform settings)</span>
      </label>
      {state.ok && <p className="notice">{state.ok}</p>}
      {state.error && <p className="error">{state.error}</p>}
      <div>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Creating…" : "Create user"}
        </button>
      </div>
    </form>
  );
}
