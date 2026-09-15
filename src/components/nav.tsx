"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_ITEMS = [
  { href: "/", label: "Aujourd'hui", icon: "☀️" },
  { href: "/emails", label: "Emails", icon: "✉️" },
  { href: "/a-valider", label: "À valider", icon: "✅" },
  { href: "/chat", label: "Chat EMA", icon: "💬" },
  { href: "/documents", label: "Documents", icon: "📁" },
  { href: "/relances", label: "Relances", icon: "⏰" },
  { href: "/historique", label: "Historique", icon: "🕓" },
  { href: "/regles", label: "Règles", icon: "⚙️" },
  { href: "/societes", label: "Sociétés", icon: "🏢" },
  { href: "/parametres", label: "Paramètres", icon: "🔧" },
] as const;

export function Nav({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="brand">
        EMA
        <small>Assistant administratif email</small>
      </div>
      {NAV_ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`}>
            <span aria-hidden>{item.icon}</span>
            <span>{item.label}</span>
            {item.href === "/a-valider" && pendingCount > 0 ? <span className="badge danger" style={{ marginLeft: "auto" }}>{pendingCount}</span> : null}
          </Link>
        );
      })}
      <div className="nav-spacer" />
      <Link href="/setup" className={`nav-link${pathname.startsWith("/setup") ? " active" : ""}`}>
        <span aria-hidden>🧭</span>
        <span>Setup</span>
      </Link>
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="btn small" style={{ width: "100%", marginTop: "0.5rem" }}>
          Se déconnecter
        </button>
      </form>
    </aside>
  );
}
