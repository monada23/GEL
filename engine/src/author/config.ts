import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTHOR_AGENTS = ["scenes", "scripts", "review", "ir"] as const;
export type AuthorAgent = (typeof AUTHOR_AGENTS)[number];

export class ConfigError extends Error {
  public readonly code: "missing_config" | "invalid_config";
  public readonly path: string;
  public constructor(code: ConfigError["code"], message: string, path: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.path = path;
  }
}

export interface AuthorProvider {
  baseUrl: string;
  apiKey: string;
}

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AuthorAgentRef {
  provider: string;
  model: string;
  reasoning?: ReasoningEffort;
  temperature?: number;
}

export interface AuthorConfig {
  providers: Record<string, AuthorProvider>;
  agents: Record<AuthorAgent, AuthorAgentRef>;
  maxConsecutiveErrors: number;
}

export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;

export const DEFAULT_AUTHOR_CONFIG: AuthorConfig = {
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
    },
  },
  agents: {
    scenes: { provider: "openai", model: "gpt-4o" },
    scripts: { provider: "openai", model: "gpt-4o" },
    review: { provider: "openai", model: "gpt-4o" },
    ir: { provider: "openai", model: "gpt-4o" },
  },
  maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
}

export function authorConfigPath(): string {
  const override = process.env.GEL_AUTHOR_CONFIG?.trim();
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(root, "gel", "author.config.json");
}

export function parseAuthorConfig(value: unknown, path: string): AuthorConfig {
  if (!isRecord(value)) throw new ConfigError("invalid_config", `Author config must be an object: ${path}`, path);
  const extra = Object.keys(value).filter((key) => key !== "providers" && key !== "agents" && key !== "maxConsecutiveErrors");
  if (extra.length > 0) throw new ConfigError("invalid_config", `Unknown config field '${extra[0]}': ${path}`, path);
  if (!isRecord(value.providers) || !isRecord(value.agents)) {
    throw new ConfigError("invalid_config", `providers and agents must be objects: ${path}`, path);
  }
  const providers: Record<string, AuthorProvider> = {};
  for (const [name, raw] of Object.entries(value.providers)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new ConfigError("invalid_config", `Invalid provider id '${name}': ${path}`, path);
    }
    if (!isRecord(raw)) throw new ConfigError("invalid_config", `Provider '${name}' must be an object: ${path}`, path);
    const providerExtra = Object.keys(raw).filter((key) => key !== "baseUrl" && key !== "apiKey");
    if (providerExtra.length > 0) {
      throw new ConfigError("invalid_config", `Unknown field '${providerExtra[0]}' on provider '${name}': ${path}`, path);
    }
    if (typeof raw.baseUrl !== "string" || raw.baseUrl.trim().length === 0) {
      throw new ConfigError("invalid_config", `Provider '${name}' baseUrl is required: ${path}`, path);
    }
    if (typeof raw.apiKey !== "string") {
      throw new ConfigError("invalid_config", `Provider '${name}' apiKey must be a string: ${path}`, path);
    }
    providers[name] = { baseUrl: raw.baseUrl.replace(/\/$/, ""), apiKey: raw.apiKey };
  }
  if (Object.keys(providers).length === 0) {
    throw new ConfigError("invalid_config", `At least one provider is required: ${path}`, path);
  }
  const agents = {} as Record<AuthorAgent, AuthorAgentRef>;
  for (const agent of AUTHOR_AGENTS) {
    const raw = value.agents[agent];
    if (!isRecord(raw)) throw new ConfigError("invalid_config", `Agent '${agent}' is required: ${path}`, path);
    const agentExtra = Object.keys(raw).filter((key) => key !== "provider" && key !== "model" && key !== "reasoning" && key !== "temperature");
    if (agentExtra.length > 0) {
      throw new ConfigError("invalid_config", `Unknown field '${agentExtra[0]}' on agent '${agent}': ${path}`, path);
    }
    if (typeof raw.provider !== "string" || providers[raw.provider] === undefined) {
      throw new ConfigError("invalid_config", `Agent '${agent}' provider '${String(raw.provider)}' is unknown: ${path}`, path);
    }
    if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
      throw new ConfigError("invalid_config", `Agent '${agent}' model is required: ${path}`, path);
    }
    let reasoning: ReasoningEffort | undefined;
    if (raw.reasoning !== undefined) {
      if (typeof raw.reasoning !== "string" || !REASONING_EFFORTS.includes(raw.reasoning as ReasoningEffort)) {
        throw new ConfigError("invalid_config", `Agent '${agent}' reasoning must be one of ${REASONING_EFFORTS.join(", ")}: ${path}`, path);
      }
      reasoning = raw.reasoning as ReasoningEffort;
    }
    let temperature: number | undefined;
    if (raw.temperature !== undefined) {
      if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
        throw new ConfigError("invalid_config", `Agent '${agent}' temperature must be a number between 0 and 2: ${path}`, path);
      }
      temperature = raw.temperature;
    }
    agents[agent] = { provider: raw.provider, model: raw.model };
    if (reasoning !== undefined) agents[agent].reasoning = reasoning;
    if (temperature !== undefined) agents[agent].temperature = temperature;
  }
  const unknownAgents = Object.keys(value.agents).filter((key) => !AUTHOR_AGENTS.includes(key as AuthorAgent));
  if (unknownAgents.length > 0) {
    throw new ConfigError("invalid_config", `Unknown agent '${unknownAgents[0]}': ${path}`, path);
  }
  let maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS;
  if (value.maxConsecutiveErrors !== undefined) {
    if (typeof value.maxConsecutiveErrors !== "number" || !Number.isInteger(value.maxConsecutiveErrors) || value.maxConsecutiveErrors < 1) {
      throw new ConfigError("invalid_config", `maxConsecutiveErrors must be a positive integer: ${path}`, path);
    }
    maxConsecutiveErrors = value.maxConsecutiveErrors;
  }
  return { providers, agents, maxConsecutiveErrors };
}

export async function loadAuthorConfig(): Promise<{ path: string; config: AuthorConfig }> {
  const path = authorConfigPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError("missing_config", `Author config not found at ${path}. Run gel-engine author config.`, path);
  }
  try {
    return { path, config: parseAuthorConfig(JSON.parse(text), path) };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("invalid_config", `Author config is not JSON: ${path}`, path);
  }
}

export function resolveAgent(
  config: AuthorConfig,
  agent: AuthorAgent,
  path = authorConfigPath(),
): AuthorProvider & { model: string; provider: string; reasoning?: ReasoningEffort; temperature?: number } {
  const ref = config.agents[agent];
  const provider = config.providers[ref.provider];
  if (provider === undefined) {
    throw new ConfigError("invalid_config", `Agent '${agent}' provider '${ref.provider}' is unknown: ${path}`, path);
  }
  return { ...provider, model: ref.model, provider: ref.provider, reasoning: ref.reasoning, temperature: ref.temperature };
}

export async function ensureAuthorConfig(): Promise<{
  ok: true;
  stage: "config";
  path: string;
  created: boolean;
  message: string;
  diagnostics: [];
}> {
  const path = authorConfigPath();
  try {
    await readFile(path, "utf8");
    return { ok: true, stage: "config", path, created: false, message: path, diagnostics: [] };
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(DEFAULT_AUTHOR_CONFIG, null, 2)}\n`, "utf8");
    return { ok: true, stage: "config", path, created: true, message: path, diagnostics: [] };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
