"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Mode = "login" | "signup";

/**
 * Connexion par compte (email + mot de passe) et, si l'instance l'autorise,
 * création d'un compte dirigeant. Aucun secret n'est conservé côté navigateur :
 * la session est un cookie httpOnly signé par le serveur.
 */
export function LoginForm({ signupAllowed, initialMode = "login" }: { signupAllowed: boolean; initialMode?: Mode }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(signupAllowed && initialMode === "signup" ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const url = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const body = mode === "login" ? { email, password } : { email, password, name: name || undefined, phone: phone || undefined };
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { message?: string } };
    setBusy(false);
    if (res.ok && json.ok) {
      router.replace(mode === "signup" ? "/parametres/connexions" : "/");
      router.refresh();
    } else {
      setError(json.error?.message ?? (mode === "login" ? "Email ou mot de passe incorrect" : "Création du compte impossible"));
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      {mode === "signup" ? (
        <div className="field">
          <label htmlFor="name">Votre nom</label>
          <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Prénom Nom" />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
      </div>
      <div className="field">
        <label htmlFor="password">Mot de passe{mode === "signup" ? " (12 caractères minimum)" : ""}</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "signup" ? 12 : 1} required />
      </div>
      {mode === "signup" ? (
        <div className="field">
          <label htmlFor="phone">Numéro WhatsApp (optionnel, activable plus tard)</label>
          <input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="+33 6 12 34 56 78" />
        </div>
      ) : null}
      {error ? <div className="alert danger">{error}</div> : null}
      <button className="btn primary" type="submit" disabled={busy}>
        {mode === "login" ? "Se connecter" : "Créer mon compte"}
      </button>
      {signupAllowed ? (
        <button type="button" className="btn small" onClick={() => setMode(mode === "login" ? "signup" : "login")} disabled={busy}>
          {mode === "login" ? "Pas encore de compte ? Créer un compte" : "J'ai déjà un compte"}
        </button>
      ) : null}
    </form>
  );
}
