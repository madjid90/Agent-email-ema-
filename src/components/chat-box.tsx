"use client";

import { useState, type FormEvent } from "react";

interface Msg {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: string;
}

export function ChatBox({ initialMessages }: { initialMessages: Msg[] }) {
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text }) });
    const json = (await res.json()) as { ok: boolean; data?: Msg[]; error?: { message: string } };
    setBusy(false);
    if (!json.ok) {
      setError(json.error?.message ?? "Erreur");
      return;
    }
    setMessages(json.data ?? []);
    setInput("");
  }

  return (
    <div className="card">
      <div className="stack" style={{ minHeight: 240, marginBottom: "1rem" }}>
        {messages.length === 0 ? <p className="muted">Aucun message. Posez une question à EMA.</p> : null}
        {messages.map((m) => (
          <div key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "80%" }}>
            <div className={`badge ${m.role === "user" ? "primary" : ""}`}>{m.role === "user" ? "Vous" : "EMA"}</div>
            <pre className="mono" style={{ marginTop: "0.25rem" }}>{m.content}</pre>
          </div>
        ))}
      </div>
      {error ? <div className="alert warn">{error}</div> : null}
      <form onSubmit={send} className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Écrire à EMA…" style={{ flex: 1 }} disabled={busy} />
        <button className="btn primary" type="submit" disabled={busy || !input.trim()}>Envoyer</button>
      </form>
    </div>
  );
}
