import { SCENE_ID_PATTERN } from "../scene/scene-id";

export const STORY_IR_FORMAT = "gel.story-ir";
export const SCENE_IR_FORMAT = "gel.scene-ir";
export const IR_FORMAT_VERSION = 1;
export const CONTEXT_START = "<!-- gel-context -->";
export const CONTEXT_END = "<!-- /gel-context -->";
export const SCENE_ID_RE = SCENE_ID_PATTERN;
export const LOCAL_ID_RE = /^[a-z][a-z0-9_-]*$/;
export const FLOW_NODE_TYPES = ["gel.dialogue", "gel.choice", "gel.if", "gel.graph_output", "gel.end_story"] as const;
export const IR_NODE_TYPES = [...FLOW_NODE_TYPES, "gel.boolean"] as const;

export type IrNodeType = (typeof IR_NODE_TYPES)[number];

export interface AuthorDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AuthorResult {
  ok: boolean;
  stage: string;
  directory: string;
  diagnostics: AuthorDiagnostic[];
  message?: string;
  [key: string]: unknown;
}

export interface AuthorStatus {
  state: "idle" | "running" | "done";
  stage: string;
  ok: boolean;
  message: string;
  diagnostics: AuthorDiagnostic[];
  result?: AuthorResult | null;
  previewFile?: string;
}

export interface SceneMarkdown {
  id: string;
  title: string;
  exits: string[];
  body: string;
}

export interface ScriptMarkdown {
  id: string;
  title: string;
  body: string;
  context: string;
}

export interface OutlineMarkdown {
  title: string;
  body: string;
}

export type SceneIrLink = readonly [string, string, string, string];

export interface DialogueIrNode {
  id: string;
  type: "gel.dialogue";
  text: string;
  speaker?: string | null;
}

export interface ChoiceIrNode {
  id: string;
  type: "gel.choice";
  choices: readonly { id: string; label: string }[];
}

export interface BooleanIrNode {
  id: string;
  type: "gel.boolean";
  value: boolean;
}

export interface IfIrNode {
  id: string;
  type: "gel.if";
}

export interface GraphOutputIrNode {
  id: string;
  type: "gel.graph_output";
  interfaceId: string;
}

export interface EndStoryIrNode {
  id: string;
  type: "gel.end_story";
}

export type SceneIrNode =
  | DialogueIrNode
  | ChoiceIrNode
  | BooleanIrNode
  | IfIrNode
  | GraphOutputIrNode
  | EndStoryIrNode;

export interface SceneIrBody {
  sceneId: string;
  title?: string;
  nodes: readonly SceneIrNode[];
  links: readonly SceneIrLink[];
}

export interface SceneIrFile extends SceneIrBody {
  format: typeof SCENE_IR_FORMAT;
  formatVersion: typeof IR_FORMAT_VERSION;
}

export interface StoryIr {
  format: typeof STORY_IR_FORMAT;
  formatVersion: typeof IR_FORMAT_VERSION;
  entryScene: string;
  scenes: readonly SceneIrBody[];
  routes: Record<string, Record<string, string>>;
}

export const AUTHORING_DIRS = ["assets", "scenes", "scripts", "ir", "review"] as const;

export const DEFAULT_OUTLINE = `# Untitled Story

Write the story outline here.
`;
