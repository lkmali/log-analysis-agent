import Link from "next/link";
import { requireDashboardSession } from "@/lib/session";
import { OrgSwitcher } from "@/components/org-switcher";

const NAV = [
  { href: "/overview", label: "Overview" },
  { href: "/alerts", label: "Alerts" },
  { href: "/incidents", label: "Incidents" },
  { href: "/logs", label: "Logs" },
  { href: "/pii", label: "PII Findings" },
  { href: "/log-sources", label: "Log Sources" },
  { href: "/system", label: "System Health" },
  { href: "/repositories", label: "Repositories" },
  { href: "/pull-requests", label: "Pull Requests" },
  { href: "/settings", label: "Settings" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, memberships, org, role } = await requireDashboardSession();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Claude SRE</div>
        <nav className="nav">
          {[...NAV, ...(user.isSuperadmin ? [{ href: "/users", label: "Users" }] : [])].map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <OrgSwitcher activeOrgId={org.id} orgs={memberships.map((m) => ({ id: m.id, name: m.name }))} />
          <span className="muted">
            {user.email} · {role}{user.isSuperadmin ? " · superadmin" : ""}
          </span>
          <form action="/auth/signout" method="post">
            <button type="submit" className="btn small">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
