import { route, ok, currentUser } from "@/lib/api";
import { searchDocuments } from "@/database/repositories/documents";

export const GET = route(async (req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  const p = new URL(req.url).searchParams;
  return ok(
    searchDocuments({
      userId: user.id,
      query: p.get("q") ?? undefined,
      supplier: p.get("supplier") ?? undefined,
      invoiceNumber: p.get("invoice") ?? undefined,
      docType: p.get("type") ?? undefined,
      requiresReview: p.get("review") === "1" ? true : undefined,
      possibleDuplicate: p.get("duplicate") === "1" ? true : undefined,
      limit: 200,
    }),
  );
});
