import { route, ok } from "@/lib/api";
import { getWhatsappStatus } from "@/integrations/whatsapp";

export const GET = route(async () => ok(getWhatsappStatus()));
