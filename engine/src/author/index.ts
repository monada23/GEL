export { authorMain, printAuthorUsage } from "./cli";
export { authorConfigPath, ensureAuthorConfig, parseAuthorConfig } from "./config";
export { validateSceneIrFile, validateStoryIr } from "./ir";
export { clientForAgent } from "./llm";
export { parseSceneMarkdown, parseScriptMarkdown, rewriteContext, splitContext } from "./markdown";
export { initAuthoring, validateAuthoring } from "./workspace";
export type { AuthorResult, SceneIrBody, SceneIrFile, StoryIr } from "./types";
