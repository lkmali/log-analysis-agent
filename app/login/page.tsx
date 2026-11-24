import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Claude SRE" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Claude SRE</h1>
        <p className="muted">Sign in to view alerts, incidents, and PII findings.</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
