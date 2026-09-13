import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { validateSceneIrFile, validateStoryIr } from "./ir";
import { MarkdownParseError, parseOutline, parseSceneMarkdown, parseScriptMarkdown } from "./markdown";
import {
  AUTHORING_DIRS,
  DEFAULT_OUTLINE,
  type AuthorDiagnostic,
  type AuthorResult,
  type AuthorStatus,
  type OutlineMarkdown,
  type SceneMarkdown,
  type ScriptMarkdown,
} from "./types";

export function authoringDirectory(path: string): string {
  return resolve(path);
}

export async function initAuthoring(directory: string): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  await mkdir(dir, { recursive: true });
  for (const name of AUTHORING_DIRS) await mkdir(join(dir, name), { recursive: true });
  const outlinePath = join(dir, "outline.md");
  try {
    await readFile(outlinePath, "utf8");
  } catch {
    await writeFile(outlinePath, DEFAULT_OUTLINE, "utf8");
  }
  await writeStatus(dir, idleStatus());
  return ok("init", dir, { message: "Authoring directory ready" });
}

export async function validateAuthoring(directory: string): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  const diagnostics: AuthorDiagnostic[] = [];
  let outline: OutlineMarkdown | undefined;
  try {
    outline = parseOutline(await readFile(join(dir, "outline.md"), "utf8"));
  } catch (error) {
    diagnostics.push(fromError(error, "outline.md"));
  }
  const scenes = await readMarkdownFiles(join(dir, "scenes"), (text, id) => parseSceneMarkdown(text, id), diagnostics);
  const scripts = await readMarkdownFiles(join(dir, "scripts"), (text, id) => parseScriptMarkdown(text, id), diagnostics);
  const irFiles = await listFiles(join(dir, "ir"), ".json");
  for (const file of irFiles) {
    const path = join(dir, "ir", file);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      const irDiagnostics = file === "story.json" ? validateStoryIr(parsed) : validateSceneIrFile(parsed);
      diagnostics.push(...irDiagnostics.map((item) => ({ ...item, path: item.path ?? `ir/${file}` })));
    } catch (error) {
      diagnostics.push(fromError(error, `ir/${file}`));
    }
  }
  return {
    ok: diagnostics.length === 0,
    stage: "validate",
    directory: dir,
    diagnostics,
    title: outline?.title,
    scenes: scenes.map((scene) => scene.id),
    scripts: scripts.map((script) => script.id),
  };
}

export async function readSceneFiles(directory: string): Promise<SceneMarkdown[]> {
  const diagnostics: AuthorDiagnostic[] = [];
  const scenes = await readMarkdownFiles(join(directory, "scenes"), (text, id) => parseSceneMarkdown(text, id), diagnostics);
  if (diagnostics.length > 0) throw new Error(diagnostics[0].message);
  return scenes;
}

export async function readScriptFiles(directory: string): Promise<ScriptMarkdown[]> {
  const diagnostics: AuthorDiagnostic[] = [];
  const scripts = await readMarkdownFiles(join(directory, "scripts"), (text, id) => parseScriptMarkdown(text, id), diagnostics);
  if (diagnostics.length > 0) throw new Error(diagnostics[0].message);
  return scripts;
}

export async function readAssetTexts(directory: string): Promise<string> {
  const files = await listFiles(join(directory, "assets"), "");
  const chunks: string[] = [];
  for (const file of files) {
    if (!/\.(md|txt)$/i.test(file)) {
      chunks.push(`asset: ${file}`);
      continue;
    }
    chunks.push(`# ${file}\n${await readFile(join(directory, "assets", file), "utf8")}`);
  }
  return chunks.join("\n\n");
}

export async function writeText(directory: string, relative: string, contents: string): Promise<void> {
  const path = join(directory, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

export async function writeStatus(directory: string, status: AuthorStatus): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export async function readStatus(directory: string): Promise<AuthorStatus> {
  try {
    return JSON.parse(await readFile(join(directory, "status.json"), "utf8")) as AuthorStatus;
  } catch {
    return idleStatus();
  }
}

export function idleStatus(): AuthorStatus {
  return { state: "idle", stage: "", ok: true, message: "", diagnostics: [], result: null };
}

export async function withStatus(directory: string, stage: string, run: () => Promise<AuthorResult>): Promise<AuthorResult> {
  const dir = authoringDirectory(directory);
  await writeStatus(dir, { state: "running", stage, ok: true, message: "", diagnostics: [], result: null });
  try {
    const result = await run();
    await writeStatus(dir, {
      state: "done",
      stage,
      ok: result.ok,
      message: result.message ?? "",
      diagnostics: result.diagnostics,
      result,
    });
    return result;
  } catch (error) {
    const diagnostics = [fromError(error)];
    const result = { ok: false, stage, directory: dir, diagnostics, message: diagnostics[0].message };
    await writeStatus(dir, { state: "done", stage, ok: false, message: result.message ?? "", diagnostics, result });
    return result;
  }
}

async function readMarkdownFiles<T>(
  directory: string,
  parse: (text: string, id: string) => T,
  diagnostics: AuthorDiagnostic[],
): Promise<T[]> {
  const files = await listFiles(directory, ".md");
  const items: T[] = [];
  for (const file of files) {
    const id = basename(file, ".md");
    try {
      items.push(parse(await readFile(join(directory, file), "utf8"), id));
    } catch (error) {
      diagnostics.push(fromError(error, `${basename(directory)}/${file}`));
    }
  }
  return items;
}

async function listFiles(directory: string, extension: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && (extension.length === 0 || extname(entry.name) === extension))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function ok(stage: string, directory: string, extra: Record<string, unknown> = {}): AuthorResult {
  return { ok: true, stage, directory, diagnostics: [], ...extra };
}

function fromError(error: unknown, path?: string): AuthorDiagnostic {
  if (error instanceof MarkdownParseError) return { code: error.code, message: error.message, path };
  if (error instanceof SyntaxError) return { code: "invalid_json", message: error.message, path };
  if (error instanceof Error) return { code: "authoring_error", message: error.message, path };
  return { code: "authoring_error", message: String(error), path };
}
