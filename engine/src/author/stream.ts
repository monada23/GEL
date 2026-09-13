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

export function foldIrEvents(events: readonly unknown[]): StoryIr {
  let entryScene = "";
  const scenes: SceneIrBody[] = [];
  const routes: Record<string, Record<string, string>> = {};
  let current: { sceneId: string; title?: string; nodes: SceneIrNode[]; links: SceneIrLink[]; ids: Set<string> } | undefined;
  const knownScenes = new Set<string>();
  const finishScene = (): void => {
    if (current === undefined) return;
    scenes.push({ sceneId: current.sceneId, title: current.title, nodes: current.nodes, links: current.links });
    knownScenes.add(current.sceneId);
    current = undefined;
  };
  for (const raw of events) {
    const event = parseIrEvent(raw);
    switch (event.op) {
      case "story":
        entryScene = event.entryScene;
        break;
      case "scene":
        finishScene();
        current = { sceneId: event.sceneId, title: event.title, nodes: [], links: [], ids: new Set(["entry"]) };
        break;
      case "node":
        if (current === undefined) throw new StreamError("node event before scene");
        if (current.ids.has(event.id)) throw new StreamError(`Duplicate node '${event.id}'`);
        current.ids.add(event.id);
        current.nodes.push(eventAsNode(event));
        break;
      case "link":
        if (current === undefined) throw new StreamError("link event before scene");
        if (!current.ids.has(event.from[0]) || !current.ids.has(event.to[0])) {
          throw new StreamError(`Link target must already exist (${event.from[0]} -> ${event.to[0]})`);
        }
        current.links.push([event.from[0], event.from[1], event.to[0], event.to[1]]);
        break;
      case "route":
        finishScene();
        routes[event.from] ??= {};
        routes[event.from][event.exit] = event.to;
        break;
      case "done":
        finishScene();
        break;
    }
  }
  finishScene();
  if (!SCENE_ID_RE.test(entryScene)) throw new StreamError("story event with entryScene is required");
  return { format: STORY_IR_FORMAT, formatVersion: IR_FORMAT_VERSION, entryScene, scenes, routes };
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
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === null || typeof choices[0] !== "object") return "";
  const content = (choices[0] as { delta?: { content?: unknown } }).delta?.content;
  return typeof content === "string" ? content : "";
}
