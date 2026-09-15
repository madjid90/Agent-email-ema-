import { ChatBox } from "@/components/chat-box";
import { getDb } from "@/database/connection";
import { listChatMessages } from "@/database/repositories/chat";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  const messages = listChatMessages(100, getDb()).map((m) => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at }));
  return (
    <>
      <h1>Chat EMA</h1>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Exemples : « Trouve-moi l&apos;email de X », « Ai-je reçu la facture Y ? », « Quels devis dois-je signer ? », « Réponds à Alexandre que le paiement sera fait vendredi ». Toute action sensible passera par une validation.
      </p>
      <ChatBox initialMessages={messages} />
    </>
  );
}
