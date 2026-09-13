import { CONTEXT_END, CONTEXT_START, type OutlineMarkdown, type SceneMarkdown, type ScriptMarkdown } from "./types";

export class MarkdownParseError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = "MarkdownParseError";
    this.code = code;
  }
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(text: string): ParsedMarkdown {
  if (typeof text !== "string") throw new MarkdownParseError("invalid_markdown", "Markdown must be a string");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match === null) throw new MarkdownParseError("missing_frontmatter", "Markdown must start with YAML frontmatter");
  return { frontmatter: parseFrontmatterBlock(match[1]), body: match[2].replace(/^\r?\n/, "") };
}

export function parseOutline(text: string): OutlineMarkdown {
  const parsed = parseMarkdown(text);
  const title = optionalString(parsed.frontmatter.title, "Untitled Story");
  return { title, body: parsed.body };
}

export function parseSceneMarkdown(text: string, filenameId?: string): SceneMarkdown {
  const parsed = parseMarkdown(text);
  const id = requiredId(parsed.frontmatter.id, "id");
  if (filenameId !== undefined && filenameId !== id) {
    throw new MarkdownParseError("scene_id_mismatch", `Scene file '${filenameId}' must match frontmatter id '${id}'`);
  }
  const title = optionalString(parsed.frontmatter.title, id);
  const exits = optionalStringArray(parsed.frontmatter.exits);
  return { id, title, exits, body: parsed.body };
}

export function parseScriptMarkdown(text: string, filenameId?: string): ScriptMarkdown {
  const parsed = parseMarkdown(text);
  const id = requiredId(parsed.frontmatter.id, "id");
  if (filenameId !== undefined && filenameId !== id) {
    throw new MarkdownParseError("script_id_mismatch", `Script file '${filenameId}' must match frontmatter id '${id}'`);
  }
  const title = optionalString(parsed.frontmatter.title, id);
  const { context, body } = splitContext(parsed.body);
  return { id, title, body, context };
}

export function serializeSceneMarkdown(doc: SceneMarkdown): string {
  const exits = doc.exits.length === 0 ? "" : `exits: [${doc.exits.join(", ")}]\n`;
  return `---\nid: ${doc.id}\ntitle: ${escapeYamlString(doc.title)}\n${exits}---\n\n${doc.body.replace(/^\n+/, "")}`;
}

export function serializeScriptMarkdown(doc: ScriptMarkdown): string {
  const withContext = rewriteContext(`---\nid: ${doc.id}\ntitle: ${escapeYamlString(doc.title)}\n---\n\n${doc.body.replace(/^\n+/, "")}`, doc.context);
  return withContext;
}

export function rewriteContext(markdown: string, context: string): string {
  const block = `${CONTEXT_START}\n${context.trim()}\n${CONTEXT_END}`;
  const start = markdown.indexOf(CONTEXT_START);
  const end = markdown.indexOf(CONTEXT_END);
  if (start !== -1 && end !== -1 && end > start) {
    return markdown.slice(0, start) + block + markdown.slice(end + CONTEXT_END.length);
  }
  const match = markdown.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
  if (match !== null) {
    const rest = markdown.slice(match[1].length).replace(/^\s+/, "");
    return `${match[1]}\n${block}\n\n${rest}`;
  }
  return `${block}\n\n${markdown}`;
}

export function splitContext(body: string): { context: string; body: string } {
  const start = body.indexOf(CONTEXT_START);
  const end = body.indexOf(CONTEXT_END);
  if (start === -1 || end === -1 || end < start) return { context: "", body };
  const context = body.slice(start + CONTEXT_START.length, end).trim();
  const stripped = `${body.slice(0, start)}${body.slice(end + CONTEXT_END.length)}`.replace(/^\s+/, "");
  return { context, body: stripped };
}

function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new MarkdownParseError("invalid_frontmatter", `Invalid frontmatter line: ${line}`);
    const key = line.slice(0, colon).trim();
    result[key] = parseYamlScalar(line.slice(colon + 1).trim());
  }
  return result;
}

function parseYamlScalar(value: string): unknown {
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((item) => unquote(item.trim())).filter((item) => item.length > 0);
  }
  return unquote(value);
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]*$/.test(value)) {
    throw new MarkdownParseError("invalid_id", `${name} must match ^[a-z][a-z0-9_.-]*$`);
  }
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string") throw new MarkdownParseError("invalid_frontmatter", "Expected a string field");
  return value;
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined || value === "") return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MarkdownParseError("invalid_frontmatter", "Expected a string list");
  }
  return value;
}

function escapeYamlString(value: string): string {
  return /[:#\[\]{}]/.test(value) ? JSON.stringify(value) : value;
}
