import { LlmError, defaultLlmClient, type LlmClient } from "./llm";
import { MarkdownParseError, parseOutline, serializeSceneMarkdown } from "./markdown";
import type { AuthorDiagnostic, AuthorResult, SceneMarkdown } from "./types";
import { authoringDirectory, readAssetTexts, writeText } from "./workspace";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SCENE_SYSTEM = `You plan Galgame scenes for GEL.
Return JSON only: {"scenes":[{"id":"prologue","title":"序章","exits":["continue"],"body":"..."}]}.
Rules:
- id matches ^[a-z][a-z0-9_.-]*$
- exits are local names, not file paths
- body uses these headings: # Goal, # Cast, # Enter, # Leave, # Relations, # Constraints
- keep the set small and playable
- do not write Lua, node JSON, or character dialogue speakers`;

export async function generateScenes(directory: string, client: LlmClient = defaultLlmClient()): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  try {
    const outline = parseOutline(await readFile(join(dir, "outline.md"), "utf8"));
    const assets = await readAssetTexts(dir);
    const user = `# Title\n${outline.title}\n\n# Outline\n${outline.body}\n\n# Assets\n${assets || "(none)"}`;
    const payload = await completeWithRetry(client, SCENE_SYSTEM, user);
    const scenes = parseScenePayload(payload);
    for (const scene of scenes) {
      await writeText(dir, `scenes/${scene.id}.md`, serializeSceneMarkdown(scene));
    }
    return { ok: true, stage: "scenes", directory: dir, diagnostics: [], scenes: scenes.map((scene) => scene.id) };
  } catch (error) {
    return { ok: false, stage: "scenes", directory: dir, diagnostics: [asDiagnostic(error)] };
  }
}

export async function generateScripts(directory: string, _sceneId?: string, _client: LlmClient = defaultLlmClient()): Promise<AuthorResult> {
  return unavailable("scripts", directory);
}

export async function reviewScripts(directory: string, _client: LlmClient = defaultLlmClient()): Promise<AuthorResult> {
  return unavailable("review", directory);
}

export async function generateIr(directory: string, _sceneId?: string, _client: LlmClient = defaultLlmClient()): Promise<AuthorResult> {
  return unavailable("ir", directory);
}

export async function completeWithRetry(client: LlmClient, system: string, user: string): Promise<unknown> {
  try {
    return await client.completeJson(system, user);
  } catch (error) {
    if (!(error instanceof LlmError) || error.code !== "invalid_llm_json") throw error;
    return client.completeJson(system, `${user}\n\nPrevious output was not valid JSON. Return a JSON object only.`);
  }
}

function parseScenePayload(payload: unknown): SceneMarkdown[] {
  if (payload === null || typeof payload !== "object" || !Array.isArray((payload as { scenes?: unknown }).scenes)) {
    throw new MarkdownParseError("invalid_llm_json", "LLM scenes payload must be {scenes: [...]}");
  }
  const scenes: SceneMarkdown[] = [];
  for (const item of (payload as { scenes: unknown[] }).scenes) {
    if (item === null || typeof item !== "object") throw new MarkdownParseError("invalid_llm_json", "Scene entry must be an object");
    const record = item as Record<string, unknown>;
    const id = requiredId(record.id);
    const title = typeof record.title === "string" && record.title.length > 0 ? record.title : id;
    const exits = Array.isArray(record.exits) ? record.exits.filter((value): value is string => typeof value === "string") : [];
    const body = typeof record.body === "string" ? record.body : "";
    scenes.push({ id, title, exits, body });
  }
  if (scenes.length === 0) throw new MarkdownParseError("invalid_llm_json", "LLM returned no scenes");
  return scenes;
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]*$/.test(value)) {
    throw new MarkdownParseError("invalid_id", "Scene id must match ^[a-z][a-z0-9_.-]*$");
  }
  return value;
}

function unavailable(stage: string, directory: string): AuthorResult {
  return {
    ok: false,
    stage,
    directory: authoringDirectory(directory),
    diagnostics: [{ code: "stage_unavailable", message: `Author stage '${stage}' is not implemented yet.` }],
  };
}

function asDiagnostic(error: unknown): AuthorDiagnostic {
  if (error instanceof LlmError || error instanceof MarkdownParseError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "authoring_error", message: error.message };
  return { code: "authoring_error", message: String(error) };
}
