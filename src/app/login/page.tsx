import { redirect } from "next/navigation";
import { isAuthConfigured, isAuthenticated } from "@/security/auth";
import { isSignupAllowed } from "@/security/accounts";
import { countUsers } from "@/database/repositories/users";
import { bootstrap } from "@/lib/bootstrap";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  bootstrap();
  if (await isAuthenticated()) redirect("/");
  const configured = isAuthConfigured();
  const firstAccount = configured && countUsers() === 0;
  return (
    <div className="login">
      <div className="card">
        <h1>EMA</h1>
        <p className="muted" style={{ marginBottom: "1rem" }}>Votre assistant email, sur le web et sur WhatsApp.</p>
        {!configured ? (
          <div className="alert warn">
            <strong>APP_SECRET</strong> doit être défini dans <code>.env</code> (32 caractères minimum) pour activer les comptes.
          </div>
        ) : (
          <>
            {firstAccount ? <div className="alert info">Aucun compte n&apos;existe encore : créez le vôtre pour commencer.</div> : null}
            <LoginForm signupAllowed={isSignupAllowed()} initialMode={firstAccount ? "signup" : "login"} />
          </>
        )}
      </div>
    </div>
  );
}
