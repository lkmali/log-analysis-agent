import { requireUser } from "@/lib/session";
import { OnboardingForm } from "./onboarding-form";

export const metadata = { title: "Create organization · Claude SRE" };

export default async function OnboardingPage() {
  await requireUser();
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Create your organization</h1>
        <p className="muted">Log sources, alerts, and incidents are scoped to an organization.</p>
        <OnboardingForm />
      </div>
    </main>
  );
}
