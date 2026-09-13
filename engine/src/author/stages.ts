import type { AuthorResult } from "./types";
import { authoringDirectory } from "./workspace";

/** LLM stages land in later commits. Stage 1 only exposes a stable import surface. */
export async function generateScenes(directory: string): Promise<AuthorResult> {
  return unavailable("scenes", directory);
}

export async function generateScripts(directory: string, _sceneId?: string): Promise<AuthorResult> {
  return unavailable("scripts", directory);
}

export async function reviewScripts(directory: string): Promise<AuthorResult> {
  return unavailable("review", directory);
}

export async function generateIr(directory: string, _sceneId?: string): Promise<AuthorResult> {
  return unavailable("ir", directory);
}

function unavailable(stage: string, directory: string): AuthorResult {
  return {
    ok: false,
    stage,
    directory: authoringDirectory(directory),
    diagnostics: [{ code: "stage_unavailable", message: `Author stage '${stage}' is not implemented yet.` }],
  };
}
