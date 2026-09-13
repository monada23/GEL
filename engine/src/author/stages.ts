import { ConfigError, DEFAULT_MAX_CONSECUTIVE_ERRORS, loadAuthorConfig } from "./config";
import { LlmError, clientForAgent, parseJsonPayload, type LlmClient } from "./llm";
import { MarkdownParseError, parseOutline, parseScriptMarkdown, serializeSceneMarkdown, serializeScriptMarkdown } from "./markdown";
import type { AuthorDiagnostic, AuthorResult, SceneMarkdown, ScriptMarkdown } from "./types";
import { appendFileSync, writeFileSync } from "node:fs";
import { authoringDirectory, readAssetTexts, readSceneFiles, readScriptFiles, writeStatus, writeText } from "./workspace";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { consumeJsonLines, emptyIrFold, finishIrFold, partialJsonString, partialJsonStringArray, pushIrEvent, StreamError } from "./stream";

const SCENE_SYSTEM = `You plan Galgame scenes for GEL.
Return JSON only: {"scenes":[{"id":"prologue","title":"序章","exits":["continue"],"body":"..."}]}.
Rules:
- id matches ^[a-z][a-z0-9_.-]*$
- exits are local names, not file paths
- body uses these headings: # Goal, # Cast, # Enter, # Leave, # Relations, # Constraints
- keep the set small and playable
- do not write Lua, node JSON, or character dialogue speakers`;

const SCENE_STREAM_SYSTEM = `You plan Galgame scenes for GEL.
Emit one JSON object per line, no wrapping array and no markdown fences.
Each line: {"id":"prologue","title":"序章","exits":["continue"],"body":"# Goal\\n..."}.
Rules:
- id matches ^[a-z][a-z0-9_.-]*$
- exits are local names, not file paths
- body uses headings: # Goal, # Cast, # Enter, # Leave, # Relations, # Constraints
- keep the set small and playable`;

export async function generateScenes(directory: string, client?: LlmClient): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  try {
    const llm = client ?? await clientForAgent("scenes");
    const outline = parseOutline(await readFile(join(dir, "outline.md"), "utf8"));
    const assets = await readAssetTexts(dir);
    const user = `${outline.body}\n\n# Assets\n${assets || "(none)"}`;
    const scenes = llm.stream === undefined
      ? parseScenePayload(await completeWithRetry(llm, SCENE_SYSTEM, user, previewDelta(dir, "scenes", "review/preview.md")))
      : await generateScenesStream(dir, llm, user);
    if (llm.stream === undefined) {
      for (const scene of scenes) {
        await writeText(dir, `scenes/${scene.id}.md`, serializeSceneMarkdown(scene));
      }
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

const SCRIPT_STREAM_SYSTEM = `You write one GEL scene script body.
Write only the script markdown body. No JSON, no YAML frontmatter, no gel-context comments.
Write playable beats the later generator can turn into narration, choice, if, output, or end.
Do not use named character speakers or Lua.`;

const SCRIPT_CONCURRENCY = 3;

export async function generateScripts(directory: string, sceneId?: string, client?: LlmClient, focus = ""): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  const diagnostics: AuthorDiagnostic[] = [];
  const written: string[] = [];
  try {
    const llm = client ?? await clientForAgent("scripts");
    const outline = parseOutline(await readFile(join(dir, "outline.md"), "utf8"));
    const scenes = await readSceneFiles(dir);
    const assets = await readAssetTexts(dir);
    const mergedFocus = [focus, await readFocus(dir)].filter((part) => part.trim().length > 0).join("\n\n");
    const prefix = packStoryPrefix(outline.title, outline.body, scenes, assets);
    const targets = sceneId === undefined ? scenes : scenes.filter((scene) => scene.id === sceneId);
    if (targets.length === 0) {
      return { ok: false, stage: "scripts", directory: dir, diagnostics: [{ code: "missing_scene", message: sceneId === undefined ? "No scene markdown to script." : `Scene '${sceneId}' is missing.` }] };
    }
    await mapPool(targets, SCRIPT_CONCURRENCY, async (scene) => {
      try {
        const task = scriptTask(scene.id, mergedFocus);
        if (llm.stream === undefined) {
          const payload = await completeWithRetry(llm, `${SCRIPT_SYSTEM}\n\n${prefix}`, task, previewDelta(dir, "scripts", "review/preview.md"));
          const script = parseScriptPayload(payload, scene);
          await writeText(dir, `scripts/${script.id}.md`, serializeScriptMarkdown({ ...script, context: prefix }));
          written.push(script.id);
        } else {
          written.push(await generateScriptStream(dir, llm, scene, prefix, task));
        }
      } catch (error) {
        diagnostics.push({ ...asDiagnostic(error), path: `scripts/${scene.id}.md` });
      }
    });
    return { ok: diagnostics.length === 0, stage: "scripts", directory: dir, diagnostics, scripts: written, failed: diagnostics.map((item) => item.path) };
  } catch (error) {
    return { ok: false, stage: "scripts", directory: dir, diagnostics: [asDiagnostic(error)] };
  }
}

const REVIEW_SYSTEM = `You review GEL galgame scripts for out-of-character writing and logic holes.
Return JSON only: {"findings":[{"sceneId":"prologue","severity":"error","kind":"ooc","excerpt":"...","suggestion":"..."}]}.
kind must be ooc or logic. severity must be error or warning.
If the scripts are consistent, return {"findings":[]}. Do not rewrite the scripts here.`;

const MAX_REVIEW_ROUNDS = 2;

export async function reviewScripts(directory: string, client?: LlmClient): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  try {
    const reviewer = client ?? await clientForAgent("review");
    let findings: ReviewFinding[] = [];
    for (let round = 1; round <= MAX_REVIEW_ROUNDS + 1; round += 1) {
      findings = await collectFindings(dir, reviewer);
      await writeText(dir, "review/findings.json", `${JSON.stringify({ round, findings }, null, 2)}\n`);
      if (findings.length === 0) {
        return { ok: true, stage: "review", directory: dir, diagnostics: [], findings, round };
      }
      if (round > MAX_REVIEW_ROUNDS) break;
      const byScene = groupFindings(findings);
      for (const [sceneId, sceneFindings] of byScene) {
        const focus = sceneFindings.map((item) => `- ${item.kind} (${item.severity}): ${item.excerpt} -> ${item.suggestion}`).join("\n");
        const patched = await generateScripts(dir, sceneId, client, `# Review notes\n${focus}`);
        if (!patched.ok) return { ...patched, findings, round };
      }
    }
    const errors = findings.filter((item) => item.severity === "error").map((item) => ({ code: "review_finding", message: `${item.sceneId}: ${item.kind} ${item.excerpt}`, path: `scripts/${item.sceneId}.md` }));
    return { ok: errors.length === 0, stage: "review", directory: dir, diagnostics: errors, findings, round: MAX_REVIEW_ROUNDS + 1 };
  } catch (error) {
    return { ok: false, stage: "review", directory: dir, diagnostics: [asDiagnostic(error)] };
  }
}

interface ReviewFinding {
  sceneId: string;
  severity: "error" | "warning";
  kind: "ooc" | "logic";
  excerpt: string;
  suggestion: string;
}

async function collectFindings(directory: string, client: LlmClient): Promise<ReviewFinding[]> {
  const outline = parseOutline(await readFile(join(directory, "outline.md"), "utf8"));
  const scenes = await readSceneFiles(directory);
  const scripts = await readScriptFiles(directory);
  if (scripts.length === 0) throw new MarkdownParseError("missing_scene", "No scripts to review.");
  const user = [`# Outline\n${outline.body}`, `# Scenes\n${scenes.map((scene) => `## ${scene.id}\n${scene.body}`).join("\n\n")}`, `# Scripts\n${scripts.map((script) => `## ${script.id}\n${script.body}`).join("\n\n")}`].join("\n\n");
  const payload = await completeWithRetry(client, REVIEW_SYSTEM, user);
  return parseFindings(payload);
}

function parseFindings(payload: unknown): ReviewFinding[] {
  if (payload === null || typeof payload !== "object" || !Array.isArray((payload as { findings?: unknown }).findings)) {
    throw new MarkdownParseError("invalid_llm_json", "Review payload must be {findings: [...]}");
  }
  const findings: ReviewFinding[] = [];
  for (const item of (payload as { findings: unknown[] }).findings) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.sceneId !== "string" || typeof record.excerpt !== "string" || typeof record.suggestion !== "string") continue;
    if (record.kind !== "ooc" && record.kind !== "logic") continue;
    if (record.severity !== "error" && record.severity !== "warning") continue;
    findings.push({ sceneId: record.sceneId, severity: record.severity, kind: record.kind, excerpt: record.excerpt, suggestion: record.suggestion });
  }
  return findings;
}

function groupFindings(findings: readonly ReviewFinding[]): Map<string, ReviewFinding[]> {
  const grouped = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    const list = grouped.get(finding.sceneId) ?? [];
    list.push(finding);
    grouped.set(finding.sceneId, list);
  }
  return grouped;
}

const IR_SYSTEM = `Convert GEL scene scripts into IR events.
Emit one JSON object per line, no markdown fences.
Start with {"op":"story","entryScene":"..."}.
Then for each scene {"op":"scene","sceneId":"...","title":"..."}, then node and link events, then {"op":"route","from":"...","exit":"...","to":"..."}.
Finish with {"op":"done"}.
Node events: {"op":"node","id":"d1","type":"gel.dialogue","text":"..."}.
Link events: {"op":"link","from":["entry","out"],"to":["d1","in"]}.
Allowed types: gel.dialogue (no speaker), gel.choice, gel.boolean, gel.if, gel.graph_output, gel.end_story.
Links may only target ids already emitted. Use entry as the scene entry id.`;

export async function generateIr(directory: string, sceneId?: string, client?: LlmClient): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  try {
    const llm = client ?? await clientForAgent("ir");
    const scenes = await readSceneFiles(dir);
    const scripts = await readScriptFiles(dir);
    const selected = sceneId === undefined ? scripts : scripts.filter((script) => script.id === sceneId);
    if (selected.length === 0) {
      return { ok: false, stage: "ir", directory: dir, diagnostics: [{ code: "missing_scene", message: "No scripts to compile into IR." }] };
    }
    const user = selected.map((script) => {
      const card = scenes.find((scene) => scene.id === script.id);
      return `# ${script.id}\n${card ? card.body : ""}\n\n${script.body}`;
    }).join("\n\n");
    const payload = llm.stream === undefined
      ? await completeWithRetry(llm, IR_SYSTEM, user)
      : await generateIrStream(dir, llm, user);
    const { validateStoryIr } = await import("./ir");
    const diagnostics = validateStoryIr(payload);
    if (diagnostics.length > 0) return { ok: false, stage: "ir", directory: dir, diagnostics };
    await writeText(dir, "ir/story.json", `${JSON.stringify(payload, null, 2)}\n`);
    const story = payload as { scenes?: { sceneId?: string }[] };
    for (const scene of story.scenes ?? []) {
      if (typeof scene.sceneId === "string") {
        await writeText(dir, `ir/${scene.sceneId}.json`, `${JSON.stringify({ format: "gel.scene-ir", formatVersion: 1, ...scene }, null, 2)}\n`);
      }
    }
    return { ok: true, stage: "ir", directory: dir, diagnostics: [], entryScene: (payload as { entryScene?: string }).entryScene };
  } catch (error) {
    return { ok: false, stage: "ir", directory: dir, diagnostics: [asDiagnostic(error)] };
  }
}

export async function completeWithRetry(client: LlmClient, system: string, user: string, onDelta?: (text: string) => void): Promise<unknown> {
  const once = async (): Promise<unknown> => {
    if (client.stream !== undefined) {
      return parseJsonPayload(await client.stream(system, user, onDelta ?? (() => undefined)));
    }
    return client.completeJson(system, user);
  };
  try {
    return await once();
  } catch (error) {
    if (!(error instanceof LlmError) || error.code !== "invalid_llm_json") throw error;
    return once();
  }
}

async function generateIrStream(directory: string, client: LlmClient, user: string): Promise<unknown> {
  const relative = "ir/stream.jsonl";
  await writeText(directory, relative, "");
  await writeStatus(directory, { state: "running", stage: "ir", ok: true, message: "", diagnostics: [], previewFile: relative });
  const limit = await irErrorLimit();
  const state = emptyIrFold();
  let extra: { role: "assistant" | "user"; content: string }[] = [];
  let consecutive = 0;
  while (!state.done) {
    let pending = "";
    let halt: Error | undefined;
    await client.stream!(IR_SYSTEM, user, (delta) => {
      if (halt !== undefined) return;
      pending += delta;
      try {
        pending = consumeJsonLines(pending, (value) => {
          if (halt !== undefined) return;
          try {
            pushIrEvent(state, value);
            appendFileSync(join(directory, relative), `${JSON.stringify(value)}\n`);
            consecutive = 0;
          } catch (error) {
            halt = error instanceof Error ? error : new Error(String(error));
          }
        });
      } catch (error) {
        halt = error instanceof Error ? error : new Error(String(error));
        pending = "";
      }
    }, extra);
    if (halt === undefined && pending.trim().length > 0) {
      try {
        const value: unknown = JSON.parse(pending.trim());
        pushIrEvent(state, value);
        appendFileSync(join(directory, relative), `${JSON.stringify(value)}\n`);
        consecutive = 0;
      } catch (error) {
        halt = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (state.done) break;
    if (halt === undefined) halt = new StreamError("stream ended before done");
    consecutive += 1;
    if (consecutive >= limit) {
      throw new StreamError(`IR generation stopped after ${limit} consecutive errors: ${halt.message}`);
    }
    extra = [
      { role: "assistant", content: state.events.map((event) => JSON.stringify(event)).join("\n") },
      { role: "user", content: `Rejected and discarded: ${halt.message}. Continue with the next valid IR event(s) only. Do not repeat accepted events.` },
    ];
    await writeStatus(directory, {
      state: "running",
      stage: "ir",
      ok: true,
      message: `IR error (${consecutive}/${limit}): ${halt.message}`,
      diagnostics: [],
      previewFile: relative,
    });
  }
  return finishIrFold(state);
 }

async function irErrorLimit(): Promise<number> {
  try {
    return (await loadAuthorConfig()).config.maxConsecutiveErrors;
  } catch {
    return DEFAULT_MAX_CONSECUTIVE_ERRORS;
  }
}

function previewDelta(directory: string, stage: string, relative: string): (text: string) => void {
  let text = "";
  void writeStatus(directory, { state: "running", stage, ok: true, message: "", diagnostics: [], previewFile: relative });
  return (delta: string) => {
    text += delta;
    writeFileSync(join(directory, relative), text);
  };
 }

async function generateScenesStream(directory: string, client: LlmClient, user: string): Promise<SceneMarkdown[]> {
  await writeStatus(directory, { state: "running", stage: "scenes", ok: true, message: "", diagnostics: [], previewFile: "" });
  let pending = "";
  let previewFile = "";
  const scenes: SceneMarkdown[] = [];
  const show = (relative: string, text: string): void => {
    writeFileSync(join(directory, relative), text);
    if (previewFile === relative) return;
    previewFile = relative;
    void writeStatus(directory, { state: "running", stage: "scenes", ok: true, message: `Writing ${relative}`, diagnostics: [], previewFile: relative });
  };
  const flushDraft = (): void => {
    const id = partialJsonString(pending, "id", true);
    if (id === undefined || !/^[a-z][a-z0-9_.-]*$/.test(id)) return;
    const draft = sceneMarkdownFromPartialJson(pending);
    if (draft.length > 0) show(`scenes/${id}.md`, draft);
  };
  await client.stream!(SCENE_STREAM_SYSTEM, user, (delta) => {
    pending += delta;
    pending = consumeJsonLines(pending, (value) => {
      const scene = sceneFromRecord(value);
      show(`scenes/${scene.id}.md`, serializeSceneMarkdown(scene));
      scenes.push(scene);
    });
    flushDraft();
  });
  if (pending.trim().length > 0) {
    const scene = sceneFromRecord(JSON.parse(pending.trim()));
    show(`scenes/${scene.id}.md`, serializeSceneMarkdown(scene));
    scenes.push(scene);
  }
  if (scenes.length === 0) throw new MarkdownParseError("invalid_llm_json", "LLM returned no scenes");
  return scenes;
 }

async function generateScriptStream(directory: string, client: LlmClient, scene: SceneMarkdown, prefix: string, task: string): Promise<string> {
  const relative = `scripts/${scene.id}.md`;
  let body = "";
  const write = (): void => {
    writeFileSync(join(directory, relative), serializeScriptMarkdown({ id: scene.id, title: scene.title, body, context: prefix }));
  };
  write();
  await writeStatus(directory, { state: "running", stage: "scripts", ok: true, message: `Writing ${relative}`, diagnostics: [], previewFile: relative });
  await client.stream!(`${SCRIPT_STREAM_SYSTEM}\n\n${prefix}`, task, (delta) => {
    body += delta;
    write();
  });
  parseScriptMarkdown(await readFile(join(directory, relative), "utf8"), scene.id);
  return scene.id;
 }
function sceneMarkdownFromPartialJson(pending: string): string {
  const id = partialJsonString(pending, "id");
  const title = partialJsonString(pending, "title");
  const body = partialJsonString(pending, "body");
  if (id === undefined && title === undefined && body === undefined) return "";
  return serializeSceneMarkdown({
    id: id && id.length > 0 ? id : "generating",
    title: title && title.length > 0 ? title : id && id.length > 0 ? id : "generating",
    exits: partialJsonStringArray(pending, "exits") ?? [],
    body: body ?? "",
  });
}

 

function sceneFromRecord(value: unknown): SceneMarkdown {
  if (value === null || typeof value !== "object") throw new MarkdownParseError("invalid_llm_json", "Scene entry must be an object");
  const record = value as Record<string, unknown>;
  const id = requiredId(record.id);
  const title = typeof record.title === "string" && record.title.length > 0 ? record.title : id;
  const exits = Array.isArray(record.exits) ? record.exits.filter((item): item is string => typeof item === "string") : [];
  const body = typeof record.body === "string" ? record.body : "";
  return { id, title, exits, body };
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

function packStoryPrefix(title: string, outline: string, scenes: readonly SceneMarkdown[], assets: string): string {
  const ordered = [...scenes].sort((a, b) => a.id.localeCompare(b.id));
  const sceneBlock = ordered.map((item) => `## ${item.id} (${item.title})\nexits: ${item.exits.join(", ") || "(none)"}\n${item.body}`).join("\n\n");
  return [`# Story\n${title}`, `# Outline\n${outline}`, `# Assets\n${assets || "(none)"}`, `# Scenes\n${sceneBlock || "(none)"}`].join("\n\n");
}

function scriptTask(sceneId: string, focus = ""): string {
  return [`# Write script for scene ${sceneId}`, focus ? `# Focus\n${focus}` : ""].filter((part) => part.length > 0).join("\n\n");
}

async function readFocus(directory: string): Promise<string> {
  try {
    return await readFile(join(directory, "review", "focus.txt"), "utf8");
  } catch {
    return "";
  }
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


function asDiagnostic(error: unknown): AuthorDiagnostic {
  if (error instanceof LlmError || error instanceof MarkdownParseError || error instanceof ConfigError || error instanceof StreamError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: "authoring_error", message: error.message };
  return { code: "authoring_error", message: String(error) };
}
