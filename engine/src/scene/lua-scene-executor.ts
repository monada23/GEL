import type { LuaApiFactory } from "../lua";
import { LuaRuntime, type LuaRequestHandler, type LuaRunOptions } from "../lua";
import type { LuaPresentationEvent } from "../lua";
import { LoadedRuntimePackage } from "../package";
import { GameState } from "../variables";
import { hasMatchingVariableDefinitions } from "./game-state-package-validation";
import { Scene } from "./scene";
import type { SceneExecutor } from "./scene-executor";
import type { SceneResult } from "./scene-result";

/** The default per-resume budget for externally supplied Runtime Package Lua. */
export const DEFAULT_LUA_SCENE_INSTRUCTION_LIMIT = 100_000;

/** Options shared by every scene run in one package session. */
export interface LuaSceneExecutorOptions {
  readonly package: LoadedRuntimePackage;
  readonly state: GameState;
  readonly handler: LuaRequestHandler;
  readonly runtime?: LuaRuntime;
  readonly signal?: AbortSignal;
  readonly sandbox?: LuaRunOptions["sandbox"];
  readonly limits?: LuaRunOptions["limits"];
  readonly capabilities?: LuaRunOptions["capabilities"];
  readonly onPresentation?: (event: LuaPresentationEvent) => void;
  readonly apiFactories?: readonly LuaApiFactory[];
}

/** Executes one validated scene from a loaded Runtime Package. */
export class LuaSceneExecutor implements SceneExecutor {
  public readonly package: LoadedRuntimePackage;
  public readonly state: GameState;

  private readonly handler: LuaRequestHandler;
  private readonly runtime: LuaRuntime;
  private readonly signal: AbortSignal | undefined;
  private readonly sandbox: LuaRunOptions["sandbox"];
  private readonly limits: LuaRunOptions["limits"];
  private readonly capabilities: LuaRunOptions["capabilities"];
  private readonly onPresentation: ((event: LuaPresentationEvent) => void) | undefined;
  private readonly apiFactories: readonly LuaApiFactory[] | undefined;

  public constructor(options: LuaSceneExecutorOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("LuaSceneExecutor options must be an object");
    if (!(options.package instanceof LoadedRuntimePackage)) throw new TypeError("LuaSceneExecutor package must be a LoadedRuntimePackage");
    if (!(options.state instanceof GameState)) throw new TypeError("LuaSceneExecutor state must be a GameState");
    if (typeof options.handler !== "function") throw new TypeError("LuaSceneExecutor handler must be a function");
    if (options.runtime !== undefined && !(options.runtime instanceof LuaRuntime)) throw new TypeError("LuaSceneExecutor runtime must be a LuaRuntime");

    this.package = options.package;
    this.state = options.state;
    this.handler = options.handler;
    this.runtime = options.runtime ?? new LuaRuntime();
    this.signal = options.signal;
    this.sandbox = {
      ...options.sandbox,
      instructionLimit: options.sandbox?.instructionLimit ?? DEFAULT_LUA_SCENE_INSTRUCTION_LIMIT,
    };
    this.limits = options.limits;
    this.capabilities = options.capabilities;
    this.onPresentation = options.onPresentation;
    this.apiFactories = options.apiFactories;
    this.assertStatePackage();
  }

  public async execute(scene: Scene): Promise<SceneResult> {
    if (!(scene instanceof Scene)) throw new TypeError("scene must be a Scene");
    if (this.package.scenes.require(scene.id) !== scene) throw new TypeError(`scene '${scene.id}' does not belong to this Runtime Package`);
    this.assertStatePackage();
    if (this.state.sceneId !== scene.id) throw new Error(`GameState sceneId '${this.state.sceneId}' does not match scene '${scene.id}'`);
    return this.runtime.run(this.package.readSceneScript(scene.id), this.handler, {
      state: this.state,
      sourceName: `${this.package.packageId}/${this.package.getSceneScriptPath(scene.id)}`,
      signal: this.signal,
      sandbox: this.sandbox,
      limits: this.limits,
      characterIds: scene.getCharacterIds(),
      exits: scene.exits,
      capabilities: this.capabilities,
      onPresentation: this.onPresentation,
      apiFactories: this.apiFactories,
    });
  }

  private assertStatePackage(): void {
    if (this.state.packageId !== this.package.packageId) {
      throw new Error(`GameState packageId '${this.state.packageId}' does not match Runtime Package '${this.package.packageId}'`);
    }
    if (this.state.schemaVersion !== this.package.saveSchemaVersion) {
      throw new Error(`GameState schemaVersion '${this.state.schemaVersion}' does not match Runtime Package schema '${this.package.saveSchemaVersion}'`);
    }
    if (!hasMatchingVariableDefinitions(this.state.variables.definitions, this.package.variables)) {
      throw new Error(`GameState variable definitions do not match Runtime Package '${this.package.packageId}'`);
    }
  }
}
