import type { CharacterDefinition } from "../character";
import { CharacterRegistry } from "../character";
import type { ReadonlyFileSystem } from "../filesystem";
import type { VariableDefinition } from "../variables";
import { AssetRegistry } from "./asset-registry";
import { RouteTable } from "./route-table";
import type { RuntimePackage, PackageMetadataDefinition, PackageEngineDefinition } from "./runtime-package";
import { SceneRegistry } from "./scene-registry";

/**
 * Immutable, validated package data shared by game sessions.
 *
 * The registries contain only static definitions. In particular, character
 * instances are deliberately created on demand for each session.
 */
export class LoadedRuntimePackage {
  public readonly files: ReadonlyFileSystem;
  public readonly assets: AssetRegistry;
  public readonly scenes: SceneRegistry;
  public readonly routes: RouteTable;
  public readonly entryScene: string;

  private readonly packageDefinition: RuntimePackage;
  private readonly characterDefinitions: readonly CharacterDefinition[];
  private readonly variableDefinitions: readonly VariableDefinition[];
  private readonly sceneScripts: ReadonlyMap<string, string>;
  private readonly scriptPaths: ReadonlyMap<string, string>;

  public constructor(
    definition: RuntimePackage,
    files: ReadonlyFileSystem,
    assets: AssetRegistry,
    scenes: SceneRegistry,
    routes: RouteTable,
    sceneScripts: ReadonlyMap<string, string>,
  ) {
    this.packageDefinition = freezeValue(cloneValue(definition)) as RuntimePackage;
    this.assets = assets;
    this.scenes = scenes;
    this.routes = routes;
    // Runtime execution must use the exact UTF-8 source that PackageLoader
    // validated. Retaining a filesystem reference here would permit a mutable
    // directory package to swap main.lua between validation and execution.
    this.sceneScripts = new Map(sceneScripts);
    this.scriptPaths = new Map(this.scenes.all().map((scene) => [scene.id, scene.mainScriptPath.value] as const));
    this.files = files;
    this.entryScene = this.packageDefinition.entryScene;
    this.characterDefinitions = this.packageDefinition.characters;
    this.variableDefinitions = this.packageDefinition.variables;
  }

  public get formatVersion(): number {
    return this.packageDefinition.formatVersion;
  }

  public get packageId(): string {
    return this.packageDefinition.packageId;
  }

  public get packageVersion(): string {
    return this.packageDefinition.packageVersion;
  }

  public get saveSchemaVersion(): number {
    return this.packageDefinition.saveSchemaVersion;
  }

  public get engine(): PackageEngineDefinition | undefined {
    return cloneValue(this.packageDefinition.engine);
  }

  public get metadata(): PackageMetadataDefinition | undefined {
    return cloneValue(this.packageDefinition.metadata);
  }

  public get characters(): readonly CharacterDefinition[] {
    return cloneValue(this.characterDefinitions);
  }

  public get variables(): readonly VariableDefinition[] {
    return cloneValue(this.variableDefinitions);
  }

  /** Return the load-time validated source snapshot for one Scene. */
  public readSceneScript(sceneId: string): string {
    this.scenes.require(sceneId);
    const source = this.sceneScripts.get(sceneId);
    if (source === undefined) throw new Error(`Validated script snapshot is missing for scene '${sceneId}'`);
    return source;
  }

  /** The load-time logical path associated with a cached scene script. */
  public getSceneScriptPath(sceneId: string): string {
    this.scenes.require(sceneId);
    const path = this.scriptPaths.get(sceneId);
    if (path === undefined) throw new Error(`Validated script path is missing for scene '${sceneId}'`);
    return path;
  }


  /** Return a fresh mutable character registry owned by one game session. */
  public createCharacterRegistry(): CharacterRegistry {
    return new CharacterRegistry(this.characters);
  }

  /** Return a fresh, detached manifest definition. */
  public toDefinition(): RuntimePackage {
    return cloneValue(this.packageDefinition);
  }

  public get manifest(): RuntimePackage {
    return this.toDefinition();
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneValue(item),
      writable: true,
    });
  }
  return clone as T;
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Array.isArray(value) ? value : Object.values(value as object)) {
      freezeValue(child);
    }
    Object.freeze(value);
  }
  return value;
}
