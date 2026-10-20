// CodeyKids' AI, asked by the web editor for the kid's page (codeykids.ai and
// the Ollama stand-in in public/preview/tools.js) and for its own "Ask the
// coding AI" tab. The lesson page hands over the GraphQL address and a token
// good for this alone; the page in the preview never sees it. The backend
// keeps the daily allowance, the safety check and the log.

export type AiAccess = { token: string; url: string };

export type AiMessage = { content: string; role: "assistant" | "system" | "user" };

export type AiRequest = { json?: boolean; maxTokens?: number; messages: AiMessage[]; temperature?: number };

const AI_CHAT = `mutation aiChat($input: AiChatInput!) {
  aiChat(input: $input) {
    blocked
    content
  }
}`;

// What a page may ask: a sensible number of messages of a sensible size.
const MESSAGES = 40;
const MESSAGE_CHARS = 12_000;

const ROLES = new Set(["assistant", "system", "user"]);

// A question from the kid's page, kept to the shape the backend takes.
export const requestFrom = (value: unknown): AiRequest | undefined => {
  if (!value || typeof value !== "object") return undefined;

  const raw = value as Record<string, unknown>;

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return undefined;

  const messages = raw.messages.slice(-MESSAGES).map((item) => {
    const message = (item ?? {}) as Record<string, unknown>;

    return {
      content: String(message.content ?? "").slice(0, MESSAGE_CHARS),
      role: (ROLES.has(String(message.role)) ? message.role : "user") as AiMessage["role"],
    };
  });

  return {
    json: raw.json === true,
    maxTokens: typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) ? Math.round(raw.maxTokens) : undefined,
    messages,
    temperature: typeof raw.temperature === "number" && Number.isFinite(raw.temperature) ? raw.temperature : undefined,
  };
};

export const askAi = async (ai: AiAccess | undefined, request: AiRequest) => {
  if (!ai) throw new Error("The AI works when this lesson is opened in CodeyKids.");

  let response: Response;

  try {
    response = await fetch(ai.url, {
      body: JSON.stringify({ query: AI_CHAT, variables: { input: { ...request, token: ai.token } } }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch {
    throw new Error("The AI could not be reached. Check the internet connection.");
  }

  const body = (await response.json().catch(() => ({}))) as {
    data?: { aiChat?: { blocked: boolean; content: string } };
    errors?: { message: string }[];
  };
  const error = body.errors?.[0]?.message;

  if (error) throw new Error(error);
  if (!body.data?.aiChat) throw new Error(`The AI did not answer (${response.status}).`);

  return body.data.aiChat;
};
