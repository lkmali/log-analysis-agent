"use client";

import { useActionState, useState } from "react";
import { createOrganization, type OnboardingState } from "./actions";

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function OnboardingForm() {
  const [state, action, pending] = useActionState<OnboardingState, FormData>(createOrganization, {});
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action} className="stack">
      <label className="field">
        <span>Organization name</span>
        <input
          name="name"
          required
          minLength={2}
          maxLength={100}
          onChange={(e) => !slugEdited && setSlug(slugify(e.target.value))}
        />
      </label>
      <label className="field">
        <span>Slug</span>
        <input
          name="slug"
          required
          value={slug}
          pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
        />
      </label>
      {state.error && <p className="error">{state.error}</p>}
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}
