import { route, ok } from "@/lib/api";
import { searchDocuments } from "@/database/repositories/documents";

export const GET = route(async (req) => {
  const p = new URL(req.url).searchParams;
  return ok(
    searchDocuments({
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
