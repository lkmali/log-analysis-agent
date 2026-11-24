import { notFound } from "next/navigation";
import { requireDashboardSession } from "@/lib/session";
import { CreateUserForm } from "./create-user-form";

export const metadata = { title: "Users · Claude SRE" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await requireDashboardSession();
  if (!session.user.isSuperadmin) notFound();

  const users = await session.query<{
    user_id: string;
    email: string;
    display_name: string | null;
    is_superadmin: boolean;
    created_at: Date;
  }>("select user_id, email, display_name, is_superadmin, created_at from app.list_users()");

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Users</h1>
          <p className="muted">Accounts on this platform. Only superadmins can see this page and add users.</p>
        </div>
      </div>

      <CreateUserForm orgs={session.memberships.map((m) => ({ id: m.id, name: m.name }))} activeOrgId={session.org.id} />

      <div className="table-wrap" style={{ marginTop: 24 }}>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Superadmin</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id}>
                <td>{u.email}</td>
                <td>{u.display_name ?? "—"}</td>
                <td>{u.is_superadmin ? "Yes" : "No"}</td>
                <td>{new Date(u.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
