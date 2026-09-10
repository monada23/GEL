import { LuaCoroutine, type LuaStep } from "./lua-coroutine";
import { loadLuaScript } from "./script-loader";
import { createCoreLuaApiRegistry } from "../api/context";
import type { LuaApiFactory, LuaApiHost } from "../api/context";
import { validateLuaResponse } from "../protocol/lua-response";
import type { LuaRequest, LuaResult } from "../protocol/lua-request";
import type { LuaResumeValue } from "../protocol/lua-response";
import type { LuaPresentationEvent } from "../protocol/presentation-command";
import type { LuaCapability } from "../values/lua-types";
import type { LuaSandboxOptions } from "../sandbox/lua-sandbox";
import type { GameState } from "../../variables";

export interface LuaRunLimits {
  /** Maximum request/yield exchanges for this Lua scene invocation. */
  readonly maxRequests?: number;
}

export const DEFAULT_LUA_RUN_MAX_REQUESTS = 10_000;

export interface LuaRequestHandler {
  (request: LuaRequest): LuaResumeValue | Promise<LuaResumeValue>;
}

export interface LuaRunOptions {
  readonly state: GameState;
  readonly sourceName?: string;
  readonly signal?: AbortSignal;
  readonly sandbox?: LuaSandboxOptions;
  readonly characterIds?: readonly string[];
  readonly exits?: readonly string[];
  readonly capabilities?: readonly LuaCapability[];
  readonly onPresentation?: (event: LuaPresentationEvent) => void;
  /** 开发期扩展 API；每次 runtime 创建独立实例。 */
  readonly apiFactories?: readonly LuaApiFactory[];
  /** Bounds repeated request/yield loops even when each resume is cheap. */
  readonly limits?: LuaRunLimits;
}

export class LuaRuntime {
  public create(source: string, options: LuaRunOptions): LuaCoroutine {
    const sourceName = options.sourceName ?? "=(scene)";
    const host: LuaApiHost = {
      variables: options.state.variables,
      characterIds: options.characterIds === undefined ? undefined : new Set(options.characterIds),
      exits: options.exits === undefined ? undefined : new Set(options.exits),
      capabilities: options.capabilities === undefined ? undefined : new Set(options.capabilities),
      emit: options.onPresentation === undefined ? undefined : (command) => options.onPresentation?.({ type: "presentation", command }),
    };
    const loaded = loadLuaScript(source, sourceName, options.sandbox);
    const registry = createCoreLuaApiRegistry(host, options.apiFactories);
    return new LuaCoroutine(loaded.mainState, loaded.coroutineState, sourceName, host, registry);
  }

  public async run(source: string, handler: LuaRequestHandler, options: LuaRunOptions): Promise<LuaResult> {
    throwIfAborted(options.signal);
    const maxRequests = normalizeMaxRequests(options.limits?.maxRequests);
    const coroutine = this.create(source, options);
    try {
      let requestCount = 0;
      let step: LuaStep = coroutine.start();
      while (step.kind === "request") {
        throwIfAborted(options.signal);
        requestCount += 1;
        if (requestCount > maxRequests) {
          throw new RangeError(`Lua request limit exceeded (${maxRequests})`);
        }
        const response = await awaitHandler(handler, step.request, options.signal);
        throwIfAborted(options.signal);
        validateLuaResponse(step.request, response);
        step = coroutine.resume(response);
      }
      return step.result;
    } catch (error) {
      if (isAbortError(error)) {
        coroutine.close();
        throw error;
      }
      throw error;
    } finally {
      if (coroutine.getStatus() !== "closed") {
        coroutine.close();
      }
    }
  }
}

function normalizeMaxRequests(value: number | undefined): number {
  const maxRequests = value ?? DEFAULT_LUA_RUN_MAX_REQUESTS;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new RangeError("limits.maxRequests must be a positive safe integer");
  }
  return maxRequests;
}

async function awaitHandler(handler: LuaRequestHandler, request: LuaRequest, signal: AbortSignal | undefined): Promise<LuaResumeValue> {
  if (signal === undefined) return handler(request);
  if (signal.aborted) throw new DOMException("Lua run cancelled", "AbortError");
  return Promise.race([
    Promise.resolve(handler(request)),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Lua run cancelled", "AbortError")), { once: true });
    }),
  ]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Lua run cancelled", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
