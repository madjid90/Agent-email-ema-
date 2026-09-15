import { route, ok, parseBody } from "@/lib/api";
import { contactsFileSchema, readConfig, writeConfig } from "@/lib/config";

export const GET = route(async () => ok(readConfig("contacts")));
export const PUT = route(async (req) => ok(writeConfig("contacts", await parseBody(req, contactsFileSchema))));
