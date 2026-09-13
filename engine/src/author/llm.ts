export interface LlmClient {
  completeJson(system: string, user: string): Promise<unknown>;
}

export class LlmError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

export function defaultLlmClient(): LlmClient {
  return new OpenAiCompatibleClient();
}

export class OpenAiCompatibleClient implements LlmClient {
  public constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY ?? "",
    private readonly baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    private readonly model = process.env.OPENAI_MODEL ?? "gpt-4o",
  ) {}

  public async completeJson(system: string, user: string): Promise<unknown> {
    if (this.apiKey.trim().length === 0) throw new LlmError("missing_api_key", "OPENAI_API_KEY is required");
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const payload = await response.text();
    if (!response.ok) throw new LlmError("llm_http", `LLM HTTP ${response.status}: ${payload.slice(0, 500)}`);
    const parsed: unknown = JSON.parse(payload);
    const content = messageContent(parsed);
    try {
      return parseJsonPayload(content);
    } catch (error) {
      throw new LlmError("invalid_llm_json", error instanceof Error ? error.message : String(error));
    }
  }
}

export function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence === null ? trimmed : fence[1]);
}

function messageContent(payload: unknown): string {
  if (payload === null || typeof payload !== "object") throw new LlmError("invalid_llm_json", "LLM response is not an object");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === undefined || typeof choices[0] !== "object" || choices[0] === null) {
    throw new LlmError("invalid_llm_json", "LLM response is missing choices");
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  if (typeof message?.content !== "string" || message.content.trim().length === 0) {
    throw new LlmError("invalid_llm_json", "LLM response is missing message content");
  }
  return message.content;
}
