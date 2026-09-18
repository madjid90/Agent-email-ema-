import { ChatBox } from "@/components/chat-box";
import { getDb } from "@/database/connection";
import { listChatMessages } from "@/database/repositories/chat";
import { requireSessionUser } from "@/security/auth";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const user = await requireSessionUser();
  const messages = listChatMessages(100, getDb(), "WEB", user.id).map((m) => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at }));
  return (
    <>
      <h1>Chat EMA</h1>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Exemples : « Trouve-moi l&apos;email de X », « Ai-je reçu la facture Y ? », « Quels emails attendent une réponse ? », « Explique-moi l&apos;analyse du dernier devis ». En phase 2, le chat lit et explique ; il n&apos;envoie, ne transfère et ne signe rien.
      </p>
      <ChatBox initialMessages={messages} />
    </>
  );
}
