import { loadAuthorConfig, resolveAgent, type AuthorAgent } from "./config";
import { readSseContent } from "./stream";

export interface LlmClient {
  completeJson(system: string, user: string): Promise<unknown>;
  stream?(system: string, user: string, onDelta: (text: string) => void): Promise<string>;
}

export class LlmError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

export class OpenAiCompatibleClient implements LlmClient {
  public constructor(
    public readonly provider: string,
    public readonly apiKey: string,
    public readonly baseUrl: string,
    public readonly model: string,
  ) {}

  public async completeJson(system: string, user: string): Promise<unknown> {
    return parseJsonPayload(await this.stream(system, user, () => undefined));
  }

  public async stream(system: string, user: string, onDelta: (text: string) => void): Promise<string> {
    if (this.apiKey.trim().length === 0) {
      throw new LlmError("missing_api_key", `Provider '${this.provider}' apiKey is empty`);
    }
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new LlmError("llm_http", `LLM HTTP ${response.status}: ${payload.slice(0, 500)}`);
    }
    if (response.body === null) throw new LlmError("llm_http", "LLM response is missing a body");
    return readSseContent(response.body, onDelta);
  }
}

export async function clientForAgent(agent: AuthorAgent): Promise<OpenAiCompatibleClient> {
  const loaded = await loadAuthorConfig();
  const resolved = resolveAgent(loaded.config, agent, loaded.path);
  return new OpenAiCompatibleClient(resolved.provider, resolved.apiKey, resolved.baseUrl, resolved.model);
}

export function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fence === null ? trimmed : fence[1]);
}
