import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { getDb } from "@/database/connection";
import { countActions } from "@/database/repositories/actions";
import { bootstrap } from "@/lib/bootstrap";
import { isAuthenticated } from "@/security/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  bootstrap();
  if (!(await isAuthenticated())) redirect("/login");
  const pending = countActions({ status: "WAITING_APPROVAL" }, getDb());
  return (
    <div className="shell">
      <Nav pendingCount={pending} />
      <main className="main">{children}</main>
    </div>
  );
}
