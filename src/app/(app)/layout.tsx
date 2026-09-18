import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { getDb } from "@/database/connection";
import { countActions } from "@/database/repositories/actions";
import { bootstrap } from "@/lib/bootstrap";
import { getSessionUser } from "@/security/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  bootstrap();
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const pending = countActions({ status: "WAITING_APPROVAL", userId: user.id }, getDb());
  return (
    <div className="shell">
      <Nav pendingCount={pending} userLabel={user.name || user.email} />
      <main className="main">{children}</main>
    </div>
  );
}
