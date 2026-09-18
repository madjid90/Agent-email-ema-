import { EmaError } from "@/lib/errors";
import type { ProviderToolPolicy } from "../types";

const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";

export interface ComposioSessionResponse {
  session_id: string;
  mcp?: { type?: string; url?: string };
  warnings?: Array<{ code?: string; message?: string }>;
}

export interface CreateComposioSessionInput {
  apiKey: string;
  externalUserId: string;
  policy: ProviderToolPolicy;
  fetchImpl?: typeof fetch;
}

interface ComposioErrorBody {
  error?: {
    message?: string;
    slug?: string;
    status?: number;
    request_id?: string;
  };
}

/**
 * Client REST minimal volontairement isolé.
 *
 * On utilise l'API v3.1 pour éviter de coupler le produit au SDK Composio.
 * Le SDK pourra être ajouté plus tard sans modifier EMA/ARCHI/SALES.
 */
export async function createComposioSession(input: CreateComposioSessionInput): Promise<ComposioSessionResponse> {
  if (!input.apiKey.trim()) {
    throw new EmaError("CONFIG", "Clé API Composio absente");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const body = {
    user_id: input.externalUserId,
    toolkits: { enabled: [...input.policy.toolkits] },
    tags: {
      ...(input.policy.tags.enable ? { enabled: [...input.policy.tags.enable] } : {}),
      ...(input.policy.tags.disable ? { disabled: [...input.policy.tags.disable] } : {}),
    },
    workbench: { enable: input.policy.sandboxEnabled },
  };

  let response: Response;
  try {
    response = await fetchImpl(`${COMPOSIO_BASE_URL}/tool_router/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": input.apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new EmaError("INTEGRATION", "Impossible de joindre Composio", { cause });
  }

  let json: ComposioSessionResponse | ComposioErrorBody | null = null;
  try {
    json = (await response.json()) as ComposioSessionResponse | ComposioErrorBody;
  } catch {
    // Réponse non JSON : on retourne une erreur assainie ci-dessous.
  }

  if (!response.ok) {
    const error = json && "error" in json ? json.error : undefined;
    throw new EmaError("INTEGRATION", "Composio a refusé la création de session", {
      details: {
        status: response.status,
        code: error?.slug,
        requestId: error?.request_id,
      },
    });
  }

  if (!json || !("session_id" in json) || typeof json.session_id !== "string") {
    throw new EmaError("INTEGRATION", "Réponse Composio invalide : session absente");
  }

  return json;
}
