import { ConfigError, DEFAULT_MAX_CONSECUTIVE_ERRORS, loadAuthorConfig } from "./config";
import { LlmError, clientForAgent, parseJsonPayload, type LlmClient } from "./llm";
import { MarkdownParseError, parseOutline, parseScriptMarkdown, serializeSceneMarkdown, serializeScriptMarkdown } from "./markdown";
import type { AuthorDiagnostic, AuthorResult, SceneMarkdown, ScriptMarkdown } from "./types";
import { appendFileSync, writeFileSync } from "node:fs";
import { authoringDirectory, pulseActivity, readAssetTexts, readSceneFiles, readScriptFiles, writeStatus, writeText } from "./workspace";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { consumeJsonLines, emptyIrFold, finishIrFold, parseIrEvent, partialJsonString, partialJsonStringArray, pushIrEvent, StreamError } from "./stream";

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
      ? parseScenePayload(await completeWithRetry(llm, SCENE_SYSTEM, user, previewDelta(dir, "scenes", "review/preview.md"), () => pulseActivity(dir)))
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
          const payload = await completeWithRetry(llm, `${SCRIPT_SYSTEM}\n\n${prefix}`, task, previewDelta(dir, "scripts", "review/preview.md"), () => pulseActivity(dir));
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
  const payload = await completeWithRetry(client, REVIEW_SYSTEM, user, undefined, () => pulseActivity(directory));
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

const IR_GRAPH_SYSTEM = `You lay out a GEL story graph.
Emit one JSON object per line, no markdown fences, in this exact order:
1. {"op":"story","entryScene":"<id>"} — id must be one of the given scenes
2. {"op":"route","from":"<scene>","exit":"<exit>","to":"<scene>"} — one per listed exit
3. {"op":"done"}
Rules:
- Do not emit scene, node, or link. Scene cards already exist.
- Do not invent scene ids or extra exits.
- route.to must be an existing scene id, never end_story.
- A scene with no exits ends in gel.end_story later; emit no route for it.
- Every listed exit must have exactly one route.
- entryScene is the first playable scene.`;

const IR_SCENE_SYSTEM = `You fill one GEL scene inner graph from its script.
Emit one JSON object per line, no markdown fences.
Order: every node, then every link. Never link to an id you have not emitted.
Do not emit story, scene, route, or done. No speakers, no Lua.

Ports (wrong names fail validation):
- entry flow out: ["entry","out"]
- gel.dialogue flow out: ["d1","next"]  (never "out")
- gel.choice flow out: ["c1","<choice.id>"]
- gel.if flow out: ["if1","true"] and ["if1","false"]
- gel.if condition: ["b1","value"] -> ["if1","condition"] from a gel.boolean
- every flow target port is "in"

Node shapes:
{"op":"node","id":"d1","type":"gel.dialogue","text":"..."}
{"op":"node","id":"c1","type":"gel.choice","choices":[{"id":"enter","label":"进去看看"},{"id":"leave","label":"直接回家"}]}
{"op":"node","id":"b1","type":"gel.boolean","value":true}
{"op":"node","id":"if1","type":"gel.if"}
{"op":"node","id":"out","type":"gel.graph_output","interfaceId":"<exit>"}
{"op":"node","id":"end","type":"gel.end_story"}

Links:
{"op":"link","from":["entry","out"],"to":["d1","in"]}
{"op":"link","from":["d1","next"],"to":["c1","in"]}

If this scene continues to another scene, each required exit is a gel.graph_output whose interfaceId equals that exit.
If this scene ends the story, use gel.end_story and no graph_output.
Local ids match ^[a-z][a-z0-9_-]*$. Choice ids must start with a letter, not a digit.`;

const IR_GRAPH_JSON_SYSTEM = `You lay out a GEL story graph.
Return JSON only: {"entryScene":"prologue","routes":{"prologue":{"enter":"library"}}}.
Use only given scene ids. Every listed exit needs a route. route.to is a scene id, never end_story. No nodes.`;

const IR_SCENE_JSON_SYSTEM = `You fill one GEL scene from its script.
Return JSON only: {"nodes":[{"id":"d1","type":"gel.dialogue","text":"..."},{"id":"end","type":"gel.end_story"}],"links":[["entry","out","d1","in"],["d1","next","end","in"]]}.
Dialogue flow port is next, not out. Choice options are {id,label} with letter-starting ids. If needs a gel.boolean linked to condition. Story end is gel.end_story, not graph_output.`;

const IR_SCENE_CONCURRENCY = 3;

export async function generateIr(directory: string, sceneId?: string, client?: LlmClient): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  try {
    const llm = client ?? await clientForAgent("ir");
    const outline = parseOutline(await readFile(join(dir, "outline.md"), "utf8"));
    const scenes = await readSceneFiles(dir);
    const scripts = await readScriptFiles(dir);
    const selected = sceneId === undefined ? scripts : scripts.filter((script) => script.id === sceneId);
    if (selected.length === 0) {
      return { ok: false, stage: "ir", directory: dir, diagnostics: [{ code: "missing_scene", message: "No scripts to compile into IR." }] };
    }
    const prefix = packStoryPrefix(outline.title, outline.body, scenes, "");
    const payload = llm.stream === undefined
      ? await generateIrComplete(llm, prefix, selected, scenes)
      : await generateIrStream(dir, llm, prefix, selected, scenes);
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

async function generateIrComplete(client: LlmClient, prefix: string, selected: readonly ScriptMarkdown[], scenes: readonly SceneMarkdown[]): Promise<unknown> {
  const graph = parseGraphPayload(await completeWithRetry(client, IR_GRAPH_JSON_SYSTEM, irGraphUser(prefix, selected, scenes)));
  const interiors = new Map<string, { nodes: unknown[]; links: unknown[] }>();
  await mapPool(selected, IR_SCENE_CONCURRENCY, async (script) => {
    interiors.set(script.id, parseSceneInterior(await completeWithRetry(client, IR_SCENE_JSON_SYSTEM, irSceneUser(prefix, script, scenes))));
  });
  return {
    format: "gel.story-ir",
    formatVersion: 1,
    entryScene: graph.entryScene,
    scenes: selected.map((script) => {
      const interior = interiors.get(script.id) ?? { nodes: [], links: [] };
      return { sceneId: script.id, title: script.title, nodes: interior.nodes, links: interior.links };
    }),
    routes: graph.routes,
  };
}

async function generateIrStream(directory: string, client: LlmClient, prefix: string, selected: readonly ScriptMarkdown[], scenes: readonly SceneMarkdown[]): Promise<unknown> {
  const relative = "ir/stream.jsonl";
  const jsonl = join(directory, relative);
  await writeText(directory, relative, "");
  await writeStatus(directory, { state: "running", stage: "ir", ok: true, message: "Laying out scenes", diagnostics: [], previewFile: relative });
  const state = emptyIrFold();
  const writeEvent = (value: unknown): void => {
    appendFileSync(jsonl, `${JSON.stringify(value)}\n`);
  };
  for (const script of selected) {
    const event = { op: "scene", sceneId: script.id, title: script.title };
    pushIrEvent(state, event);
    writeEvent(event);
  }
  const accepted: unknown[] = [];
  await runJsonlStream(client, IR_GRAPH_SYSTEM, irGraphUser(prefix, selected, scenes), (value) => {
    const event = parseIrEvent(value);
    if (event.op === "node" || event.op === "link" || event.op === "scene") {
      throw new StreamError(`graph step cannot emit ${event.op}`);
    }
    pushIrEvent(state, value);
    accepted.push(value);
    if (event.op === "story" || event.op === "route") writeEvent(event);
  }, () => state.done, () => accepted.map((item) => JSON.stringify(item)).join("\n"), "done-op", directory);
  state.done = false;
  let filled = 0;
  let flush = Promise.resolve();
  await mapPool(selected, IR_SCENE_CONCURRENCY, async (script) => {
    const events = await generateSceneInteriorStream(client, prefix, script, scenes, directory);
    flush = flush.then(() => {
      for (const event of events) {
        pushIrEvent(state, event);
        writeEvent(event);
      }
      filled += 1;
      void writeStatus(directory, { state: "running", stage: "ir", ok: true, message: `Filled scene ${script.id} (${filled}/${selected.length})`, diagnostics: [], previewFile: relative });
    });
    await flush;
  });
  pushIrEvent(state, { op: "done" });
  writeEvent({ op: "done" });
  return finishIrFold(state);
}

async function generateSceneInteriorStream(client: LlmClient, prefix: string, script: ScriptMarkdown, scenes: readonly SceneMarkdown[], directory: string): Promise<unknown[]> {
  const events: unknown[] = [{ op: "scene", sceneId: script.id, title: script.title }];
  const ids = new Set<string>(["entry"]);
  const kinds = new Map<string, string>([["entry", "entry"]]);
  const choiceIds = new Map<string, string[]>();
  const accepted: unknown[] = [];
  let finished = false;
  await runJsonlStream(client, IR_SCENE_SYSTEM, irSceneUser(prefix, script, scenes), (value) => {
    const normalized = normalizeSceneEvent(value, kinds, choiceIds);
    const event = parseIrEvent(normalized);
    if (event.op === "done") {
      finished = true;
      return;
    }
    if (event.op !== "node" && event.op !== "link") throw new StreamError(`scene step cannot emit ${event.op}`);
    if (event.op === "node") {
      if (ids.has(event.id)) throw new StreamError(`Duplicate node '${event.id}'`);
      ids.add(event.id);
      kinds.set(event.id, event.type);
      const choices = "choices" in event ? (event as { choices?: unknown }).choices : undefined;
      if (event.type === "gel.choice" && Array.isArray(choices)) {
        choiceIds.set(event.id, choices.map((item) => String((item as { id: string }).id)));
      }
    } else if (!ids.has(event.from[0]) || !ids.has(event.to[0])) {
      throw new StreamError(`Link target must already exist (${event.from[0]} -> ${event.to[0]})`);
    }
    events.push(normalized);
    accepted.push(normalized);
  }, () => finished, () => accepted.map((item) => JSON.stringify(item)).join("\n"), "stream-end", directory);
  if (ids.size <= 1) throw new StreamError(`Scene '${script.id}' emitted no nodes`);
  return events;
}

async function runJsonlStream(
  client: LlmClient,
  system: string,
  user: string,
  onObject: (value: unknown) => void,
  isDone: () => boolean,
  acceptedText: () => string,
  until: "done-op" | "stream-end",
  directory: string,
): Promise<void> {
  const limit = await irErrorLimit();
  let extra: { role: "assistant" | "user"; content: string }[] = [];
  let consecutive = 0;
  while (!isDone()) {
    let pending = "";
    let halt: Error | undefined;
    await client.stream!(system, user, (delta) => {
      pulseActivity(directory);
      if (halt !== undefined) return;
      pending += delta;
      try {
        pending = consumeJsonLines(pending, (value) => {
          if (halt !== undefined) return;
          try {
            onObject(value);
            consecutive = 0;
          } catch (error) {
            halt = error instanceof Error ? error : new Error(String(error));
          }
        });
      } catch (error) {
        halt = error instanceof Error ? error : new Error(String(error));
        pending = "";
      }
    }, extra, () => pulseActivity(directory));
    if (halt === undefined && pending.trim().length > 0) {
      try {
        onObject(JSON.parse(pending.trim()));
        consecutive = 0;
      } catch (error) {
        halt = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (isDone()) break;
    if (halt === undefined) {
      if (until === "stream-end") break;
      halt = new StreamError("stream ended before done");
    }
    consecutive += 1;
    if (consecutive >= limit) {
      throw new StreamError(`IR generation stopped after ${limit} consecutive errors: ${halt.message}`);
    }
    extra = [
      { role: "assistant", content: acceptedText() },
      { role: "user", content: `Rejected and discarded: ${halt.message}. Continue with the next valid IR event(s) only. Do not repeat accepted events.` },
    ];
    await writeStatus(directory, { state: "running", stage: "ir", ok: true, message: `IR error (${consecutive}/${limit}): ${halt.message}`, diagnostics: [] });
  }
}

function irGraphUser(prefix: string, selected: readonly ScriptMarkdown[], scenes: readonly SceneMarkdown[]): string {
  const cards = selected.map((script) => {
    const card = scenes.find((scene) => scene.id === script.id);
    return `## ${script.id} (${script.title})\nexits: ${card?.exits.join(", ") || "(none)"}`;
  }).join("\n");
  return `${prefix}\n\n# Connect these scenes\n${cards}\n\nEmit story, then one route per listed exit, then done.`;
}

function irSceneUser(prefix: string, script: ScriptMarkdown, scenes: readonly SceneMarkdown[]): string {
  const card = scenes.find((scene) => scene.id === script.id);
  const exits = card?.exits.join(", ") || "(none)";
  return `${prefix}\n\n# Fill scene ${script.id}\nRequired graph_output interfaceIds: ${exits}\n\n# Script\n${script.body}\n\nEmit nodes first, then links. Dialogue uses next (not out). First link must leave entry.`;
}

function parseGraphPayload(payload: unknown): { entryScene: string; routes: Record<string, Record<string, string>> } {
  if (payload === null || typeof payload !== "object") throw new StreamError("graph payload must be an object");
  const record = payload as Record<string, unknown>;
  if (typeof record.entryScene !== "string") throw new StreamError("graph.entryScene required");
  if (record.routes === undefined) return { entryScene: record.entryScene, routes: {} };
  if (record.routes === null || typeof record.routes !== "object" || Array.isArray(record.routes)) throw new StreamError("graph.routes must be an object");
  const routes: Record<string, Record<string, string>> = {};
  for (const [from, mapping] of Object.entries(record.routes as Record<string, unknown>)) {
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) throw new StreamError(`routes.${from} must be an object`);
    routes[from] = {};
    for (const [exit, to] of Object.entries(mapping as Record<string, unknown>)) {
      if (typeof to !== "string") throw new StreamError(`routes.${from}.${exit} must be a scene id`);
      routes[from][exit] = to;
    }
  }
  return { entryScene: record.entryScene, routes };
}

function normalizeSceneEvent(raw: unknown, kinds: Map<string, string>, choiceIds: Map<string, string[]>): unknown {
  if (raw === null || typeof raw !== "object" || !("op" in raw)) return raw;
  const event = raw as Record<string, unknown>;
  if (event.op === "node" && event.type === "gel.choice") {
    return { ...event, choices: normalizeChoices(event.choices) };
  }
  if (event.op === "link" && Array.isArray(event.from) && event.from.length === 2 && typeof event.from[0] === "string" && typeof event.from[1] === "string") {
    const from: [string, string] = [event.from[0], event.from[1]];
    if (from[1] === "out" && kinds.get(from[0]) === "gel.dialogue") from[1] = "next";
    const indexed = choiceIds.get(from[0]);
    if (indexed !== undefined && /^\d+$/.test(from[1])) {
      const id = indexed[Number(from[1])];
      if (id !== undefined) from[1] = id;
    }
    return { ...event, from };
  }
  return raw;
}

function normalizeChoices(raw: unknown): { id: string; label: string }[] {
  if (!Array.isArray(raw)) return [];
  const choices: { id: string; label: string }[] = [];
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label : typeof record.text === "string" ? record.text : "";
    let id = typeof record.id === "string" ? record.id : typeof record.port === "string" ? record.port : "";
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) id = `c${index}`;
    if (label.length === 0) continue;
    choices.push({ id, label });
  }
  return choices;
}

function parseSceneInterior(payload: unknown): { nodes: unknown[]; links: unknown[] } {
  if (payload === null || typeof payload !== "object") throw new StreamError("scene IR payload must be an object");
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.nodes) || !Array.isArray(record.links)) throw new StreamError("scene IR requires nodes and links arrays");
  const kinds = new Map<string, string>([["entry", "entry"]]);
  const choiceIds = new Map<string, string[]>();
  const nodes = record.nodes.map((node) => {
    const normalized = normalizeSceneEvent({ op: "node", ...(node as object) }, kinds, choiceIds);
    const event = normalized as { op: string; id?: string; type?: string; choices?: { id: string }[] };
    if (typeof event.id === "string" && typeof event.type === "string") {
      kinds.set(event.id, event.type);
      if (event.type === "gel.choice" && Array.isArray(event.choices)) choiceIds.set(event.id, event.choices.map((item) => item.id));
    }
    const { op: _op, ...rest } = event as { op: string } & Record<string, unknown>;
    return rest;
  });
  const links = record.links.map((link) => {
    if (!Array.isArray(link) || link.length !== 4) return link;
    const normalized = normalizeSceneEvent({ op: "link", from: [link[0], link[1]], to: [link[2], link[3]] }, kinds, choiceIds) as { from: [string, string]; to: [string, string] };
    return [normalized.from[0], normalized.from[1], normalized.to[0], normalized.to[1]];
  });
  return { nodes, links };
}
export async function completeWithRetry(client: LlmClient, system: string, user: string, onDelta?: (text: string) => void, onActivity?: (text: string) => void): Promise<unknown> {
  const once = async (): Promise<unknown> => {
    if (client.stream !== undefined) {
      return parseJsonPayload(await client.stream(system, user, onDelta ?? (() => undefined), [], onActivity));
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
  }, [], () => pulseActivity(directory));
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
  }, [], () => pulseActivity(directory));
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
