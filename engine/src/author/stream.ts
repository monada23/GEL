import {
  IR_FORMAT_VERSION,
  IR_NODE_TYPES,
  LOCAL_ID_RE,
  SCENE_ID_RE,
  STORY_IR_FORMAT,
  type SceneIrBody,
  type SceneIrLink,
  type SceneIrNode,
  type StoryIr,
} from "./types";
export class StreamError extends Error {
  public readonly code = "invalid_ir_event";
  public constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

export type IrEvent =
  | { op: "story"; entryScene: string }
  | { op: "scene"; sceneId: string; title?: string }
  | { op: "node"; id: string; type: string; [key: string]: unknown }
  | { op: "link"; from: [string, string]; to: [string, string] }
  | { op: "route"; from: string; exit: string; to: string }
  | { op: "done" };

export async function readSseContent(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let full = "";
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    pending += decoder.decode(read.value, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      const delta = sseDelta(line);
      if (delta.length > 0) {
        full += delta;
        onDelta(delta);
      }
    }
  }
  const tail = sseDelta(pending);
  if (tail.length > 0) {
    full += tail;
    onDelta(tail);
  }
  return full;
}

export function consumeJsonLines(buffer: string, onObject: (value: unknown) => void): string {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.trim();
    if (line.length === 0) continue;
    onObject(JSON.parse(line));
  }
  return rest;
}


const JSON_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

export function partialJsonString(text: string, key: string, requireClosed = false): string | undefined {
  const start = jsonKeyValueStart(text, key);
  if (start < 0) return undefined;
  let i = skipWs(text, start);
  if (i >= text.length) return requireClosed ? undefined : "";
  if (text[i] !== '"') return undefined;
  const read = readPartialJsonString(text, i + 1);
  if (requireClosed && !read.closed) return undefined;
  return read.value;
}

export function partialJsonStringArray(text: string, key: string): string[] | undefined {
  const start = jsonKeyValueStart(text, key);
  if (start < 0) return undefined;
  let i = skipWs(text, start);
  if (i >= text.length) return [];
  if (text[i] !== "[") return undefined;
  i += 1;
  const values: string[] = [];
  while (i < text.length) {
    i = skipWs(text, i);
    if (i >= text.length) return values;
    if (text[i] === "]") return values;
    if (text[i] === ",") { i += 1; continue; }
    if (text[i] !== '"') return values;
    const read = readPartialJsonString(text, i + 1);
    values.push(read.value);
    if (!read.closed) return values;
    i = read.end;
  }
  return values;
}

function jsonKeyValueStart(text: string, key: string): number {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
  const match = re.exec(text);
  return match === null ? -1 : match.index + match[0].length;
}

function skipWs(text: string, index: number): number {
  while (index < text.length && (text[index] === " " || text[index] === "\n" || text[index] === "\r" || text[index] === "\t")) index += 1;
  return index;
}

function readPartialJsonString(text: string, index: number): { value: string; closed: boolean; end: number } {
  let i = index;
  let value = "";
  while (i < text.length) {
    const char = text[i];
    if (char === '"') return { value, closed: true, end: i + 1 };
    if (char === "\\") {
      if (i + 1 >= text.length) return { value, closed: false, end: i };
      const next = text[i + 1];
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) return { value, closed: false, end: i };
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      value += JSON_ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    value += char;
    i += 1;
  }
  return { value, closed: false, end: i };
}

export interface IrFoldState {
  events: IrEvent[];
  entryScene: string;
  scenes: SceneIrBody[];
  routes: Record<string, Record<string, string>>;
  current?: { sceneId: string; title?: string; nodes: SceneIrNode[]; links: SceneIrLink[]; ids: Set<string> };
  done: boolean;
}

export function emptyIrFold(): IrFoldState {
  return { events: [], entryScene: "", scenes: [], routes: {}, done: false };
 }

export function pushIrEvent(state: IrFoldState, raw: unknown): void {
  if (state.done) throw new StreamError("event after done");
  const event = parseIrEvent(raw);
  const finishScene = (): void => {
    if (state.current === undefined) return;
    state.scenes.push({ sceneId: state.current.sceneId, title: state.current.title, nodes: state.current.nodes, links: state.current.links });
    state.current = undefined;
  };
  switch (event.op) {
    case "story":
      if (state.entryScene.length > 0) throw new StreamError("duplicate story event");
      state.entryScene = event.entryScene;
      break;
    case "scene": {
      finishScene();
      const index = state.scenes.findIndex((scene) => scene.sceneId === event.sceneId);
      if (index >= 0) {
        const prev = state.scenes[index];
        state.scenes.splice(index, 1);
        const ids = new Set<string>(["entry"]);
        for (const node of prev.nodes) ids.add(node.id);
        state.current = { sceneId: prev.sceneId, title: event.title ?? prev.title, nodes: [...prev.nodes], links: [...prev.links], ids };
      } else {
        state.current = { sceneId: event.sceneId, title: event.title, nodes: [], links: [], ids: new Set(["entry"]) };
      }
      break;
    }
    case "node":
      if (state.current === undefined) throw new StreamError("node event before scene");
      if (state.current.ids.has(event.id)) throw new StreamError(`Duplicate node '${event.id}'`);
      state.current.ids.add(event.id);
      state.current.nodes.push(eventAsNode(event));
      break;
    case "link":
      if (state.current === undefined) throw new StreamError("link event before scene");
      if (!state.current.ids.has(event.from[0]) || !state.current.ids.has(event.to[0])) {
        throw new StreamError(`Link target must already exist (${event.from[0]} -> ${event.to[0]})`);
      }
      state.current.links.push([event.from[0], event.from[1], event.to[0], event.to[1]]);
      break;
    case "route":
      finishScene();
      state.routes[event.from] ??= {};
      state.routes[event.from][event.exit] = event.to;
      break;
    case "done":
      finishScene();
      state.done = true;
      break;
  }
  state.events.push(event);
 }

export function finishIrFold(state: IrFoldState): StoryIr {
  if (!state.done) {
    if (state.current !== undefined) {
      state.scenes.push({ sceneId: state.current.sceneId, title: state.current.title, nodes: state.current.nodes, links: state.current.links });
      state.current = undefined;
    }
  }
  if (!SCENE_ID_RE.test(state.entryScene)) throw new StreamError("story event with entryScene is required");
  return { format: STORY_IR_FORMAT, formatVersion: IR_FORMAT_VERSION, entryScene: state.entryScene, scenes: state.scenes, routes: state.routes };
 }

export function foldIrEvents(events: readonly unknown[]): StoryIr {
  const state = emptyIrFold();
  for (const raw of events) pushIrEvent(state, raw);
  return finishIrFold(state);
 }

export function parseIrEvent(value: unknown): IrEvent {
  if (value === null || typeof value !== "object" || !("op" in value)) {
    throw new StreamError("IR event must have op");
  }
  const record = value as Record<string, unknown>;
  switch (record.op) {
    case "story":
      if (typeof record.entryScene !== "string") throw new StreamError("story.entryScene required");
      return { op: "story", entryScene: record.entryScene };
    case "scene":
      if (typeof record.sceneId !== "string") throw new StreamError("scene.sceneId required");
      return { op: "scene", sceneId: record.sceneId, title: typeof record.title === "string" ? record.title : undefined };
    case "node":
      if (typeof record.id !== "string" || !LOCAL_ID_RE.test(record.id)) throw new StreamError("node.id invalid");
      if (typeof record.type !== "string" || !IR_NODE_TYPES.includes(record.type as (typeof IR_NODE_TYPES)[number])) {
        throw new StreamError(`unsupported node type '${String(record.type)}'`);
      }
      return record as IrEvent;
    case "link":
      if (!isPair(record.from) || !isPair(record.to)) throw new StreamError("link.from/to required");
      return { op: "link", from: record.from, to: record.to };
    case "route":
      if (typeof record.from !== "string" || typeof record.exit !== "string" || typeof record.to !== "string") {
        throw new StreamError("route.from/exit/to required");
      }
      return { op: "route", from: record.from, exit: record.exit, to: record.to };
    case "done":
      return { op: "done" };
    default:
      throw new StreamError(`Unknown IR event '${String(record.op)}'`);
  }
}

function eventAsNode(event: Extract<IrEvent, { op: "node" }>): SceneIrNode {
  return event as unknown as SceneIrNode;
}

function isPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string";
}

function sseDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice(5).trim();
  if (data.length === 0 || data === "[DONE]") return "";
  const parsed: unknown = JSON.parse(data);
  if (parsed === null || typeof parsed !== "object") return "";
  const record = parsed as { type?: unknown; delta?: unknown };
  if (record.type === "error" || record.type === "response.failed") {
    throw new Error(typeof (parsed as { error?: { message?: unknown } }).error?.message === "string"
      ? String((parsed as { error: { message: string } }).error.message)
      : "LLM response failed");
  }
  if (record.type === "response.output_text.delta" && typeof record.delta === "string") return record.delta;
  return "";
 }
