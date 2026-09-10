import { DEFAULT_LUA_RUN_MAX_REQUESTS, type LuaRequestHandler, type LuaRunOptions } from "../lua";
import type { LuaPresentationEvent } from "../lua";
import { LoadedRuntimePackage } from "../package";
import { GameState } from "../variables";
import { hasMatchingVariableDefinitions } from "./game-state-package-validation";
import { LuaSceneExecutor } from "./lua-scene-executor";
import type { SceneId } from "./scene-id";
import type { SceneResult } from "./scene-result";

export class StoryRuntimeError extends Error {
  public readonly code: "INVALID_STATE" | "MISSING_ROUTE" | "TRANSITION_LIMIT" | "REQUEST_LIMIT" | "ABORTED" | "ALREADY_RUNNING";
  public readonly sceneId: string | undefined;
  public readonly port: string | undefined;
  public constructor(code: StoryRuntimeError["code"], message: string, details: { sceneId?: string; port?: string; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause }); this.name = "StoryRuntimeError";
    this.code = code; this.sceneId = details.sceneId; this.port = details.port;
  }
}

export interface StoryRunOptions {
  readonly package: LoadedRuntimePackage; readonly state?: GameState; readonly handler: LuaRequestHandler;
  readonly signal?: AbortSignal; readonly maxTransitions?: number; readonly sandbox?: LuaRunOptions["sandbox"];
  readonly limits?: LuaRunOptions["limits"];
  /** Total request/yield exchanges allowed across the complete story session. */
  readonly capabilities?: LuaRunOptions["capabilities"]; readonly onPresentation?: (event: LuaPresentationEvent) => void;
  readonly apiFactories?: LuaRunOptions["apiFactories"]; readonly onSceneStart?: (sceneId: SceneId) => void;
  readonly onSceneEnd?: (sceneId: SceneId, result: SceneResult) => void;
}
export interface StoryRunResult { readonly state: GameState; readonly completed: true; readonly scenes: readonly SceneId[]; readonly transitions: number; }

/** Runs scenes and follows their declared package routes until end_story. */
export class StoryRunner {
  public readonly package: LoadedRuntimePackage; public readonly state: GameState;
  private readonly options: StoryRunOptions; private readonly maxTransitions: number;
  private readonly maxRequests: number;
  private running = false;
  public constructor(options: StoryRunOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("StoryRunner options must be an object");
    if (!(options.package instanceof LoadedRuntimePackage)) throw new TypeError("StoryRunner package must be a LoadedRuntimePackage");
    if (typeof options.handler !== "function") throw new TypeError("StoryRunner handler must be a function");
    if (options.state !== undefined && !(options.state instanceof GameState)) throw new TypeError("StoryRunner state must be a GameState");
    this.package = options.package;
    this.state = options.state ?? new GameState({ packageId: this.package.packageId, schemaVersion: this.package.saveSchemaVersion, sceneId: this.package.entryScene, variables: this.package.variables });
    this.options = options; this.maxTransitions = options.maxTransitions ?? 1000;
    this.maxRequests = options.limits?.maxRequests ?? DEFAULT_LUA_RUN_MAX_REQUESTS;
    if (!Number.isSafeInteger(this.maxTransitions) || this.maxTransitions < 1) throw new TypeError("maxTransitions must be a positive safe integer");
    if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1) throw new TypeError("limits.maxRequests must be a positive safe integer");
    this.assertState();
  }
  public async run(): Promise<StoryRunResult> {
    if (this.running) throw new StoryRuntimeError("ALREADY_RUNNING", "StoryRunner is already running");
    this.running = true;
    try {
      return await this.runSession();
    } finally {
      this.running = false;
    }
  }
  private async runSession(): Promise<StoryRunResult> {
    const scenes: SceneId[] = []; let transitions = 0;
    let requestCount = 0;
    const handler: LuaRequestHandler = async (request) => {
      requestCount += 1;
      const maxRequests = this.maxRequests;
      if (requestCount > maxRequests) {
        throw new StoryRuntimeError("REQUEST_LIMIT", `Story exceeded the request limit of ${maxRequests}`);
      }
      return this.options.handler(request);
    };
    while (true) {
      this.throwIfAborted(); this.assertState(); const scene = this.package.scenes.require(this.state.sceneId); scenes.push(scene.id); this.options.onSceneStart?.(scene.id);
      const executor = new LuaSceneExecutor({ package: this.package, state: this.state, handler, signal: this.options.signal, sandbox: this.options.sandbox, limits: this.options.limits, capabilities: this.options.capabilities, onPresentation: this.options.onPresentation, apiFactories: this.options.apiFactories });
      let result: SceneResult;
      try { result = await executor.execute(scene); } catch (error) {
        if (isAbortError(error)) throw new StoryRuntimeError("ABORTED", "Story run cancelled", { sceneId: scene.id, cause: error }); throw error;
      }
      this.options.onSceneEnd?.(scene.id, result);
      if (result.type === "end") return { state: this.state, completed: true, scenes, transitions };
      if (!scene.hasExit(result.port)) throw new StoryRuntimeError("MISSING_ROUTE", `Scene '${scene.id}' returned undeclared exit '${result.port}'`, { sceneId: scene.id, port: result.port });
      const target = this.package.routes.resolve(scene.id, result.port);
      if (target === undefined) throw new StoryRuntimeError("MISSING_ROUTE", `No route for scene '${scene.id}' exit '${result.port}'`, { sceneId: scene.id, port: result.port });
      transitions += 1; if (transitions > this.maxTransitions) throw new StoryRuntimeError("TRANSITION_LIMIT", `Story exceeded the transition limit of ${this.maxTransitions}`, { sceneId: scene.id, port: result.port });
      this.state.sceneId = target;
    }
  }
  private assertState(): void {
    if (this.state.packageId !== this.package.packageId || this.state.schemaVersion !== this.package.saveSchemaVersion || !hasMatchingVariableDefinitions(this.state.variables.definitions, this.package.variables)) {
      throw new StoryRuntimeError("INVALID_STATE", `GameState does not match Runtime Package '${this.package.packageId}'`);
    }
    if (!this.package.scenes.has(this.state.sceneId)) throw new StoryRuntimeError("INVALID_STATE", `GameState references unknown scene '${this.state.sceneId}'`, { sceneId: this.state.sceneId });
  }
  private throwIfAborted(): void { if (this.options.signal?.aborted) throw new StoryRuntimeError("ABORTED", "Story run cancelled", { cause: new DOMException("Story run cancelled", "AbortError") }); }
}
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
