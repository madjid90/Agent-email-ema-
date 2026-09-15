import { redirect } from "next/navigation";
import { isAuthConfigured, isAuthenticated } from "@/security/auth";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/");
  return (
    <div className="login">
      <div className="card">
        <h1>EMA</h1>
        {isAuthConfigured() ? (
          <LoginForm />
        ) : (
          <div className="alert warn">
            <strong>APP_PASSWORD</strong> et <strong>APP_SECRET</strong> doivent être définis dans <code>.env</code> pour activer l&apos;accès (obligatoire en production).
          </div>
        )}
      </div>
    </div>
  );
}
