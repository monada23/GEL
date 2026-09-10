#!/usr/bin/env node
import { DirectoryFileSystem } from "../filesystem";
import { PackageLoader } from "../package";
import { DEFAULT_LUA_SCENE_INSTRUCTION_LIMIT, StoryRunner } from "../scene";
import type { LuaRequest } from "../lua";

/** Small development CLI for validating and smoke-running Runtime Packages. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  const packageDirectory = argv[1];
  if ((command !== "validate" && command !== "run") || packageDirectory === undefined || argv.includes("--help")) {
    printUsage();
    return 2;
  }
  if (command === "run" && !argv.includes("--auto")) {
    console.error("run currently requires --auto (interactive presentation is provided by a host adapter)");
    return 2;
  }

  try {
    const files = new DirectoryFileSystem(packageDirectory);
    const loaded = new PackageLoader(files).load();
    if (command === "validate") {
      console.log(JSON.stringify({ valid: true, packageId: loaded.packageId, entryScene: loaded.entryScene }));
      return 0;
    }

    const requests: LuaRequest[] = [];
    const runner = new StoryRunner({
      package: loaded,
      // Keep the CLI's safety policy explicit at the process boundary. The
      // executor also supplies this default for other StoryRunner hosts.
      sandbox: { instructionLimit: DEFAULT_LUA_SCENE_INSTRUCTION_LIMIT },
      handler: (request) => {
        requests.push(request);
        if (request.type === "choice") {
          const option = request.options.find((candidate) => candidate.enabled !== false);
          if (option === undefined) throw new Error("Auto mode cannot answer a choice with no enabled options");
          return option.id;
        }
        return undefined;
      },
    });
    const result = await runner.run();
    console.log(JSON.stringify({
      completed: result.completed,
      packageId: loaded.packageId,
      scenes: result.scenes,
      transitions: result.transitions,
      requests,
      variables: result.state.snapshot(),
    }));
    return 0;
  } catch (error) {
    console.error(formatError(error));
    return 1;
  }
}

function printUsage(): void {
  console.error("Usage: gel-engine validate <package-dir>");
  console.error("       gel-engine run <package-dir> --auto");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

if (require.main === module) {
  void main().then((code) => { process.exitCode = code; });
}
