import { SCENE_ID_RE } from "./types";
import {
  IR_FORMAT_VERSION,
  IR_NODE_TYPES,
  LOCAL_ID_RE,
  SCENE_IR_FORMAT,
  STORY_IR_FORMAT,
  type AuthorDiagnostic,
  type SceneIrBody,
  type SceneIrFile,
  type SceneIrLink,
  type SceneIrNode,
  type StoryIr,
} from "./types";

export function validateStoryIr(value: unknown): AuthorDiagnostic[] {
  if (!isRecord(value)) return [diag("invalid_ir", "Story IR must be an object")];
  const diagnostics: AuthorDiagnostic[] = [];
  if (value.format !== STORY_IR_FORMAT) diagnostics.push(diag("invalid_ir", `format must be ${STORY_IR_FORMAT}`));
  if (value.formatVersion !== IR_FORMAT_VERSION) diagnostics.push(diag("invalid_ir", "formatVersion must be 1"));
  if (typeof value.entryScene !== "string" || !SCENE_ID_RE.test(value.entryScene)) {
    diagnostics.push(diag("invalid_scene_id", "entryScene must be a stable scene id"));
  }
  if (!Array.isArray(value.scenes)) {
    diagnostics.push(diag("invalid_ir", "scenes must be an array"));
    return diagnostics;
  }
  if (!isRecord(value.routes)) {
    diagnostics.push(diag("invalid_ir", "routes must be an object"));
    return diagnostics;
  }
  const sceneIds = new Set<string>();
  const exitsByScene = new Map<string, string[]>();
  for (const [index, scene] of value.scenes.entries()) {
    const path = `scenes[${index}]`;
    const sceneDiagnostics = validateSceneBody(scene, path);
    diagnostics.push(...sceneDiagnostics);
    if (!isRecord(scene) || typeof scene.sceneId !== "string") continue;
    if (sceneIds.has(scene.sceneId)) diagnostics.push(diag("duplicate_scene", `Duplicate scene '${scene.sceneId}'`, path));
    sceneIds.add(scene.sceneId);
    exitsByScene.set(scene.sceneId, collectExits(scene));
  }
  if (typeof value.entryScene === "string" && sceneIds.size > 0 && !sceneIds.has(value.entryScene)) {
    diagnostics.push(diag("missing_scene", `entryScene '${value.entryScene}' is not in scenes`));
  }
  diagnostics.push(...validateRoutes(value.routes, sceneIds, exitsByScene));
  return diagnostics;
}

export function validateSceneIrFile(value: unknown): AuthorDiagnostic[] {
  if (!isRecord(value)) return [diag("invalid_ir", "Scene IR must be an object")];
  const diagnostics: AuthorDiagnostic[] = [];
  if (value.format !== SCENE_IR_FORMAT) diagnostics.push(diag("invalid_ir", `format must be ${SCENE_IR_FORMAT}`));
  if (value.formatVersion !== IR_FORMAT_VERSION) diagnostics.push(diag("invalid_ir", "formatVersion must be 1"));
  diagnostics.push(...validateSceneBody(value, ""));
  return diagnostics;
}

export function asStoryIr(value: unknown): StoryIr {
  const diagnostics = validateStoryIr(value);
  if (diagnostics.length > 0) throw new Error(diagnostics[0].message);
  return value as StoryIr;
}

export function asSceneIrFile(value: unknown): SceneIrFile {
  const diagnostics = validateSceneIrFile(value);
  if (diagnostics.length > 0) throw new Error(diagnostics[0].message);
  return value as SceneIrFile;
}

function validateSceneBody(value: unknown, path: string): AuthorDiagnostic[] {
  if (!isRecord(value)) return [diag("invalid_ir", "Scene must be an object", path)];
  const diagnostics: AuthorDiagnostic[] = [];
  if (typeof value.sceneId !== "string" || !SCENE_ID_RE.test(value.sceneId)) {
    diagnostics.push(diag("invalid_scene_id", "sceneId must match ^[a-z][a-z0-9_.-]*$", path));
  }
  if (value.title !== undefined && typeof value.title !== "string") {
    diagnostics.push(diag("invalid_ir", "title must be a string", path));
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.links)) {
    diagnostics.push(diag("invalid_ir", "nodes and links must be arrays", path));
    return diagnostics;
  }
  const nodes = new Map<string, SceneIrNode>();
  for (const [index, node] of value.nodes.entries()) {
    const nodePath = join(path, `nodes[${index}]`);
    const nodeDiagnostics = validateNode(node, nodePath);
    diagnostics.push(...nodeDiagnostics);
    if (!isRecord(node) || typeof node.id !== "string") continue;
    if (node.id === "entry") diagnostics.push(diag("reserved_id", "Node id 'entry' is reserved", nodePath));
    if (nodes.has(node.id)) diagnostics.push(diag("duplicate_node", `Duplicate node '${node.id}'`, nodePath));
    if (nodeDiagnostics.length === 0) nodes.set(node.id, node as unknown as SceneIrNode);
  }
  const links: SceneIrLink[] = [];
  for (const [index, link] of value.links.entries()) {
    const linkPath = join(path, `links[${index}]`);
    if (!isLink(link)) {
      diagnostics.push(diag("invalid_link", "Link must be [source, sourcePort, target, targetPort]", linkPath));
      continue;
    }
    links.push(link);
  }
  if (diagnostics.length === 0) diagnostics.push(...validateFlow(nodes, links, path));
  return diagnostics;
}

function validateNode(value: unknown, path: string): AuthorDiagnostic[] {
  if (!isRecord(value)) return [diag("invalid_ir", "Node must be an object", path)];
  if (typeof value.id !== "string" || !LOCAL_ID_RE.test(value.id)) {
    return [diag("invalid_id", "Node id must match ^[a-z][a-z0-9_-]*$", path)];
  }
  if (typeof value.type !== "string" || !IR_NODE_TYPES.includes(value.type as SceneIrNode["type"])) {
    return [diag("unsupported_node_type", `Node type '${String(value.type)}' is not supported by canvas export`, path)];
  }
  switch (value.type) {
    case "gel.dialogue":
      if (typeof value.text !== "string" || value.text.trim().length === 0) {
        return [diag("missing_required_input", "Dialogue text is required", path)];
      }
      if (value.speaker !== undefined && value.speaker !== null && value.speaker !== "") {
        return [diag("unsupported_speaker", "Dialogue speaker must be empty for Runtime Package v1 export", path)];
      }
      return [];
    case "gel.choice":
      if (!Array.isArray(value.choices) || value.choices.length === 0) {
        return [diag("empty_choice", "Choice node must contain at least one option", path)];
      }
      const seen = new Set<string>();
      for (const choice of value.choices) {
        if (!isRecord(choice) || typeof choice.id !== "string" || !LOCAL_ID_RE.test(choice.id) || typeof choice.label !== "string") {
          return [diag("invalid_choice", "Choice option requires id and label", path)];
        }
        if (seen.has(choice.id)) return [diag("invalid_choice", `Duplicate choice id '${choice.id}'`, path)];
        seen.add(choice.id);
      }
      return [];
    case "gel.boolean":
      return typeof value.value === "boolean" ? [] : [diag("invalid_value", "Boolean node requires a boolean value", path)];
    case "gel.if":
      return [];
    case "gel.graph_output":
      if (value.interfaceId === "enter") {
        return [diag("invalid_output", "graph_output interfaceId cannot be enter", path)];
      }
      return typeof value.interfaceId === "string" && SCENE_ID_RE.test(value.interfaceId)
        ? []
        : [diag("invalid_output", "graph_output requires interfaceId", path)];
    case "gel.end_story":
      return [];
    default:
      return [diag("unsupported_node_type", `Node type '${String(value.type)}' is not supported`, path)];
  }
}

function validateFlow(nodes: Map<string, SceneIrNode>, links: readonly SceneIrLink[], path: string): AuthorDiagnostic[] {
  const diagnostics: AuthorDiagnostic[] = [];
  const flowOut = new Map<string, SceneIrLink[]>();
  const dataIn = new Map<string, SceneIrLink[]>();
  const add = (map: Map<string, SceneIrLink[]>, key: string, link: SceneIrLink): void => {
    const list = map.get(key) ?? [];
    list.push(link);
    map.set(key, list);
  };
  for (const link of links) {
    const [source, sourcePort, target, targetPort] = link;
    if (source !== "entry" && !nodes.has(source)) diagnostics.push(diag("missing_node", `Link source '${source}' does not exist`, path));
    if (!nodes.has(target)) diagnostics.push(diag("missing_node", `Link target '${target}' does not exist`, path));
    if (targetPort === "condition") add(dataIn, `${target}:${targetPort}`, link);
    else add(flowOut, `${source}:${sourcePort}`, link);
  }
  const requiredFlow = new Set<string>(["entry:out"]);
  for (const node of nodes.values()) {
    switch (node.type) {
      case "gel.dialogue":
        requiredFlow.add(`${node.id}:next`);
        break;
      case "gel.if":
        requiredFlow.add(`${node.id}:true`);
        requiredFlow.add(`${node.id}:false`);
        break;
      case "gel.choice":
        for (const choice of node.choices) requiredFlow.add(`${node.id}:${choice.id}`);
        break;
      default:
        break;
    }
  }
  for (const key of requiredFlow) {
    const outgoing = flowOut.get(key) ?? [];
    if (outgoing.length === 0) diagnostics.push(diag("missing_flow_link", `Flow output '${key}' must connect to exactly one target`, path));
    if (outgoing.length > 1) diagnostics.push(diag("ambiguous_flow_link", `Flow output '${key}' has more than one target`, path));
  }
  for (const node of nodes.values()) {
    if (node.type !== "gel.if") continue;
    const incoming = dataIn.get(`${node.id}:condition`) ?? [];
    if (incoming.length !== 1) {
      diagnostics.push(diag("missing_required_input", `If '${node.id}' requires one Boolean condition link`, path));
      continue;
    }
    const source = nodes.get(incoming[0][0]);
    if (source?.type !== "gel.boolean" || incoming[0][1] !== "value") {
      diagnostics.push(diag("unsupported_data_link", `If '${node.id}' condition must come from a Boolean node`, path));
    }
  }
  diagnostics.push(...detectFlowCycle(nodes, flowOut, path));
  return diagnostics;
}

function detectFlowCycle(nodes: Map<string, SceneIrNode>, flowOut: Map<string, SceneIrLink[]>, path: string): AuthorDiagnostic[] {
  const adjacency = new Map<string, string[]>();
  adjacency.set("entry", []);
  for (const id of nodes.keys()) adjacency.set(id, []);
  for (const links of flowOut.values()) {
    for (const [source, , target] of links) {
      const list = adjacency.get(source) ?? [];
      list.push(target);
      adjacency.set(source, list);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle: string[] = [];
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      cycle.push(id);
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (visit("entry")) return [diag("flow_cycle", `Reachable runtime flow must not contain a cycle at '${cycle[0]}'`, path)];
  return [];
}

function collectExits(scene: unknown): string[] {
  if (!isRecord(scene) || !Array.isArray(scene.nodes)) return [];
  return scene.nodes
    .filter((node): node is GraphOutputLike => isRecord(node) && node.type === "gel.graph_output" && typeof node.interfaceId === "string")
    .map((node) => node.interfaceId);
}

function validateRoutes(
  routes: Record<string, unknown>,
  sceneIds: Set<string>,
  exitsByScene: Map<string, string[]>,
): AuthorDiagnostic[] {
  const diagnostics: AuthorDiagnostic[] = [];
  for (const [sceneId, mapping] of Object.entries(routes)) {
    if (!sceneIds.has(sceneId)) {
      diagnostics.push(diag("invalid_route", `Route source '${sceneId}' is not a scene`));
      continue;
    }
    if (!isRecord(mapping)) {
      diagnostics.push(diag("invalid_route", `Routes for '${sceneId}' must be an object`));
      continue;
    }
    const declared = new Set(exitsByScene.get(sceneId) ?? []);
    for (const [exit, target] of Object.entries(mapping)) {
      if (!declared.has(exit)) diagnostics.push(diag("invalid_route", `Exit '${exit}' is not declared by '${sceneId}'`));
      if (typeof target !== "string" || !sceneIds.has(target)) {
        diagnostics.push(diag("invalid_route", `Route '${sceneId}.${exit}' target is missing`));
      }
    }
    for (const exit of declared) {
      if (mapping[exit] === undefined) diagnostics.push(diag("missing_route", `Scene '${sceneId}' exit '${exit}' has no route`));
    }
  }
  for (const [sceneId, exits] of exitsByScene) {
    if (exits.length > 0 && routes[sceneId] === undefined) {
      diagnostics.push(diag("missing_route", `Scene '${sceneId}' has exits but no routes`));
    }
  }
  return diagnostics;
}

function isLink(value: unknown): value is SceneIrLink {
  return Array.isArray(value) && value.length === 4 && value.every((part) => typeof part === "string" && part.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function join(path: string, suffix: string): string {
  return path.length === 0 ? suffix : `${path}.${suffix}`;
}

function diag(code: string, message: string, path?: string): AuthorDiagnostic {
  return path === undefined || path.length === 0 ? { code, message } : { code, message, path };
}

interface GraphOutputLike {
  type: "gel.graph_output";
  interfaceId: string;
}
