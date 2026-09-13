import { ensureAuthorConfig } from "./config";
import { initAuthoring, validateAuthoring, withStatus } from "./workspace";
import type { AuthorResult } from "./types";

const STAGES = new Set(["init", "validate", "scenes", "scripts", "review", "ir"]);

export async function authorMain(argv: readonly string[] = []): Promise<number> {
  const stage = argv[0];
  if (stage === "config" && !argv.includes("--help")) {
    const result = await ensureAuthorConfig();
    console.log(JSON.stringify({ ok: result.ok, stage: result.stage, path: result.path, created: result.created }));
    return 0;
  }
  const directory = argv[1];
  if (stage === undefined || directory === undefined || argv.includes("--help") || !STAGES.has(stage)) {
    printAuthorUsage();
    return 2;
  }
  const extra = parseFlags(argv.slice(2));
  const result = await withStatus(directory, stage, async () => dispatch(stage, directory, extra));
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

export function printAuthorUsage(): void {
  console.error("Usage: gel-engine author init <dir>");
  console.error("       gel-engine author validate <dir>");
  console.error("       gel-engine author scenes <dir>");
  console.error("       gel-engine author scripts <dir> [--scene id]");
  console.error("       gel-engine author review <dir>");
  console.error("       gel-engine author ir <dir> [--scene id]");
  console.error("       gel-engine author config");
}

async function dispatch(stage: string, directory: string, extra: { scene?: string }): Promise<AuthorResult> {
  if (stage === "init") return initAuthoring(directory);
  if (stage === "validate") return validateAuthoring(directory);
  const loaded = await loadStages();
  if (stage === "scenes") return loaded.generateScenes(directory);
  if (stage === "scripts") return loaded.generateScripts(directory, extra.scene);
  if (stage === "review") return loaded.reviewScripts(directory);
  return loaded.generateIr(directory, extra.scene);
}

async function loadStages(): Promise<typeof import("./stages")> {
  return import("./stages");
}

function parseFlags(argv: readonly string[]): { scene?: string } {
  const sceneIndex = argv.indexOf("--scene");
  if (sceneIndex === -1) return {};
  const scene = argv[sceneIndex + 1];
  return scene === undefined ? {} : { scene };
}
