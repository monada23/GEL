import { LlmError, defaultLlmClient, type LlmClient } from "./llm";
import { MarkdownParseError, parseOutline, serializeSceneMarkdown, serializeScriptMarkdown } from "./markdown";
import type { AuthorDiagnostic, AuthorResult, SceneMarkdown, ScriptMarkdown } from "./types";
import { authoringDirectory, readAssetTexts, readSceneFiles, writeText } from "./workspace";
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

const SCRIPT_SYSTEM = `You write one GEL scene script.
Return JSON only: {"id":"prologue","title":"序章","body":"..."}.
Write playable beats the later generator can turn into narration, choice, if, output, or end.
Do not use named character speakers, stage directions as engine calls, or Lua.
Keep the user-facing script in body; context is supplied separately.`;

const SCRIPT_CONCURRENCY = 3;

export async function generateScripts(directory: string, sceneId?: string, client: LlmClient = defaultLlmClient()): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  const diagnostics: AuthorDiagnostic[] = [];
  const written: string[] = [];
  try {
    const outline = parseOutline(await readFile(join(dir, "outline.md"), "utf8"));
    const scenes = await readSceneFiles(dir);
    const assets = await readAssetTexts(dir);
    const targets = sceneId === undefined ? scenes : scenes.filter((scene) => scene.id === sceneId);
    if (targets.length === 0) {
      return { ok: false, stage: "scripts", directory: dir, diagnostics: [{ code: "missing_scene", message: sceneId === undefined ? "No scene markdown to script." : `Scene '${sceneId}' is missing.` }] };
    }
    await mapPool(targets, SCRIPT_CONCURRENCY, async (scene) => {
      try {
        const context = packSceneContext(outline.title, outline.body, scene, scenes, assets);
        const payload = await completeWithRetry(client, SCRIPT_SYSTEM, `${context}\n\n# Write script for scene ${scene.id}`);
        const script = parseScriptPayload(payload, scene);
        await writeText(dir, `scripts/${script.id}.md`, serializeScriptMarkdown({ ...script, context }));
        written.push(script.id);
      } catch (error) {
        diagnostics.push({ ...asDiagnostic(error), path: `scripts/${scene.id}.md` });
      }
    });
    return { ok: diagnostics.length === 0, stage: "scripts", directory: dir, diagnostics, scripts: written, failed: diagnostics.map((item) => item.path) };
  } catch (error) {
    return { ok: false, stage: "scripts", directory: dir, diagnostics: [asDiagnostic(error)] };
  }
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

function parseScriptPayload(payload: unknown, scene: SceneMarkdown): ScriptMarkdown {
  if (payload === null || typeof payload !== "object") throw new MarkdownParseError("invalid_llm_json", "LLM script payload must be an object");
  const record = payload as Record<string, unknown>;
  const id = typeof record.id === "string" ? requiredId(record.id) : scene.id;
  if (id !== scene.id) throw new MarkdownParseError("script_id_mismatch", `Script id '${id}' must match scene '${scene.id}'`);
  const title = typeof record.title === "string" && record.title.length > 0 ? record.title : scene.title;
  const body = typeof record.body === "string" ? record.body : "";
  if (body.trim().length === 0) throw new MarkdownParseError("invalid_llm_json", "Script body is empty");
  return { id, title, body, context: "" };
}

function packSceneContext(title: string, outline: string, scene: SceneMarkdown, scenes: readonly SceneMarkdown[], assets: string, focus = ""): string {
  const others = scenes.filter((item) => item.id !== scene.id).map((item) => `## ${item.id} (${item.title})\nexits: ${item.exits.join(", ") || "(none)"}\n${item.body}`).join("\n\n");
  const neighbors = scenes.filter((item) => item.id !== scene.id && (scene.exits.includes(item.id) || item.exits.includes(scene.id) || scene.body.includes(item.id) || item.body.includes(scene.id)));
  const neighborText = neighbors.length === 0 ? "(none)" : neighbors.map((item) => `${item.id}: ${item.title}`).join(", ");
  return [`# Story\n${title}`, `# Outline\n${outline}`, `# This scene\n${scene.id} (${scene.title})\nexits: ${scene.exits.join(", ") || "(none)"}\n${scene.body}`, `# Neighbors\n${neighborText}`, `# Other scenes\n${others || "(none)"}`, `# Assets\n${assets || "(none)"}`, focus ? `# Focus\n${focus}` : ""].filter((part) => part.length > 0).join("\n\n");
}

async function mapPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => run());
  await Promise.all(workers);
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
