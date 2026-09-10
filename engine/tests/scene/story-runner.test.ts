import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/filesystem";
import { LuaSceneExecutor, StoryRunner, StoryRuntimeError } from "../../src/scene";
import { PackageLoader } from "../../src/package";
import { GameState } from "../../src/variables";

function loadPackage(scripts: Record<string, string>, routes: Record<string, Record<string, string>> = {}) {
  const sceneIds = Object.keys(scripts);
  const manifest = {
    formatVersion: 1, packageId: "test.story", packageVersion: "1.0.0", saveSchemaVersion: 1,
    entryScene: sceneIds[0], assets: [], characters: [],
    variables: [{ key: "visited", schema: { type: "boolean" }, defaultValue: false }],
    scenes: sceneIds.map((id) => ({ id, mainScript: `scenes/${id}/main.lua`, exits: Object.keys(routes[id] ?? {}) })), routes,
  };
  return new PackageLoader(new MemoryFileSystem({
    "manifest.json": JSON.stringify(manifest),
    ...Object.fromEntries(sceneIds.map((id) => [`scenes/${id}/main.lua`, scripts[id]])),
  })).load();
}

describe("LuaSceneExecutor", () => {
  it("runs a package scene with its state, presentation handler, cast and exits", async () => {
    const loaded = loadPackage({ start: `return function(ctx) ctx.dialogue:narrate("Ready"); ctx.state:set("visited", true); return ctx.flow:exit("next") end`, end: "return function(ctx) return ctx.flow:end_story() end" }, { start: { next: "end" } });
    const state = new GameState({ packageId: loaded.packageId, schemaVersion: loaded.saveSchemaVersion, sceneId: "start", variables: loaded.variables });
    const requests: unknown[] = [];
    const executor = new LuaSceneExecutor({ package: loaded, state, handler: (request) => { requests.push(request); return undefined; } });
    await expect(executor.execute(loaded.scenes.require("start"))).resolves.toEqual({ type: "exit", port: "next" });
    expect(requests).toEqual([{ type: "dialogue", mode: "narration", speaker: null, text: "Ready" }]);
    expect(state.variables.get("visited")).toBe(true);
  });

  it("uses a finite default instruction budget and preserves explicit sandbox settings", async () => {
    const loaded = loadPackage({ start: "return function(ctx) while true do end end" });
    const state = new GameState({ packageId: loaded.packageId, schemaVersion: loaded.saveSchemaVersion, sceneId: "start", variables: loaded.variables });
    await expect(new LuaSceneExecutor({ package: loaded, state, handler: () => undefined, sandbox: { libraries: ["math"] } }).execute(loaded.scenes.require("start"))).rejects.toThrow(/instruction limit exceeded/);
    await expect(new LuaSceneExecutor({ package: loaded, state, handler: () => undefined, sandbox: { libraries: ["math"], instructionLimit: 1_000_000 } }).execute(loaded.scenes.require("start"))).rejects.toThrow(/instruction limit exceeded/);
  });

  it("rejects state and scene boundaries that do not belong to its package session", async () => {
    const loaded = loadPackage({ start: "return function(ctx) return ctx.flow:end_story() end" });
    const wrongState = new GameState({ packageId: "other.story", schemaVersion: 1, sceneId: "start", variables: [] });
    expect(() => new LuaSceneExecutor({ package: loaded, state: wrongState, handler: () => undefined })).toThrow(/packageId/);
    const state = new GameState({ packageId: loaded.packageId, schemaVersion: loaded.saveSchemaVersion, sceneId: "other", variables: loaded.variables });
    const executor = new LuaSceneExecutor({ package: loaded, state, handler: () => undefined });
    await expect(executor.execute(loaded.scenes.require("start"))).rejects.toThrow(/does not match scene/);
  });

  it("rejects state variable definitions that differ semantically from the package", () => {
    const loaded = loadPackage({ start: "return function(ctx) return ctx.flow:end_story() end" });
    const variants = [
      loaded.variables.map((definition) => ({ ...definition, key: "other" })),
      loaded.variables.map((definition) => ({ ...definition, schema: { type: "string" as const }, defaultValue: "x" })),
      loaded.variables.map((definition) => ({ ...definition, defaultValue: true })),
      loaded.variables.map((definition) => ({ ...definition, readonly: true })),
    ];
    for (const variables of variants) {
      expect(() => new StoryRunner({ package: loaded, state: new GameState({ packageId: loaded.packageId, schemaVersion: loaded.saveSchemaVersion, sceneId: "start", variables }), handler: () => undefined })).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    }
  });
});

describe("StoryRunner", () => {
  it("follows routes, keeps one GameState, and returns an end result", async () => {
    const loaded = loadPackage({ start: "return function(ctx) ctx.state:set('visited', true); return ctx.flow:exit('next') end", finish: "return function(ctx) return ctx.flow:end_story() end" }, { start: { next: "finish" } });
    const result = await new StoryRunner({ package: loaded, handler: () => undefined }).run();
    expect(result.completed).toBe(true); expect(result.scenes).toEqual(["start", "finish"]); expect(result.transitions).toBe(1); expect(result.state.sceneId).toBe("finish"); expect(result.state.variables.get("visited")).toBe(true);
  });

  it("answers choices through the injected handler and respects an abort signal", async () => {
    const loaded = loadPackage({ start: "return function(ctx) local value = ctx.dialogue:choice({ { id = 'go', text = 'Go' } }); return ctx.flow:exit(value) end", finish: "return function(ctx) return ctx.flow:end_story() end" }, { start: { go: "finish" } });
    expect((await new StoryRunner({ package: loaded, handler: () => "go" }).run()).scenes).toEqual(["start", "finish"]);
    const controller = new AbortController(); controller.abort();
    await expect(new StoryRunner({ package: loaded, handler: () => "go", signal: controller.signal }).run()).rejects.toMatchObject({ name: "StoryRuntimeError", code: "ABORTED" } satisfies Partial<StoryRuntimeError>);
  });

  it("fails deterministically when a route loop crosses the configured transition limit", async () => {
    const loaded = loadPackage({ start: "return function(ctx) return ctx.flow:exit('again') end" }, { start: { again: "start" } });
    await expect(new StoryRunner({ package: loaded, handler: () => undefined, maxTransitions: 2 }).run()).rejects.toMatchObject({ name: "StoryRuntimeError", code: "TRANSITION_LIMIT" } satisfies Partial<StoryRuntimeError>);
  });

  it("fails deterministically when a route loop crosses the configured transition limit", async () => {
    const loaded = loadPackage({ start: "return function(ctx) return ctx.flow:exit('again') end" }, { start: { again: "start" } });
    await expect(new StoryRunner({ package: loaded, handler: () => undefined, maxTransitions: 2 }).run()).rejects.toMatchObject({ name: "StoryRuntimeError", code: "TRANSITION_LIMIT" } satisfies Partial<StoryRuntimeError>);
  });

  it("enforces the story-wide request budget across scene transitions", async () => {
    const loaded = loadPackage({ start: "return function(ctx) ctx.dialogue:narrate('one'); return ctx.flow:exit('next') end", finish: "return function(ctx) ctx.dialogue:narrate('two'); return ctx.flow:end_story() end" }, { start: { next: "finish" } });
    await expect(new StoryRunner({ package: loaded, handler: () => undefined, limits: { maxRequests: 1 } }).run()).rejects.toMatchObject({ code: "REQUEST_LIMIT" } satisfies Partial<StoryRuntimeError>);
  });

  it("rejects a concurrent run on the same mutable story session", async () => {
    const loaded = loadPackage({ start: "return function(ctx) ctx.dialogue:narrate('wait'); return ctx.flow:end_story() end" });
    let release: (() => void) | undefined;
    const runner = new StoryRunner({ package: loaded, handler: () => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }) });
    const first = runner.run();
    await Promise.resolve();
    await expect(runner.run()).rejects.toMatchObject({ name: "StoryRuntimeError", code: "ALREADY_RUNNING" } satisfies Partial<StoryRuntimeError>);
    release?.();
    await expect(first).resolves.toMatchObject({ completed: true });
  });

  it("rejects state that references another package or an unknown scene", () => {
    const loaded = loadPackage({ start: "return function(ctx) return ctx.flow:end_story() end" });
    expect(() => new StoryRunner({ package: loaded, state: new GameState({ packageId: "other", schemaVersion: 1, sceneId: "start", variables: [] }), handler: () => undefined })).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
  });
});
