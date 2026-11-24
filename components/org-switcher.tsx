"use client";

import { useTransition } from "react";
import { switchOrganization } from "./org-actions";

export function OrgSwitcher({
  orgs,
  activeOrgId,
}: {
  orgs: { id: string; name: string }[];
  activeOrgId: string;
}) {
  const [pending, startTransition] = useTransition();
  if (orgs.length < 2) return <strong>{orgs[0]?.name}</strong>;

  return (
    <select
      aria-label="Organization"
      defaultValue={activeOrgId}
      disabled={pending}
      onChange={(e) => {
        const id = e.target.value;
        startTransition(() => switchOrganization(id));
      }}
    >
      {orgs.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
