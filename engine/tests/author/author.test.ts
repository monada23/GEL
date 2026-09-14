import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authorMain } from "../../src/author/cli";
import { validateSceneIrFile, validateStoryIr } from "../../src/author/ir";
import { parseOutline, parseSceneMarkdown, parseScriptMarkdown, rewriteContext, splitContext } from "../../src/author/markdown";
import { initAuthoring, validateAuthoring, writeStatus } from "../../src/author/workspace";

const validScene = {
  sceneId: "prologue",
  title: "序章",
  nodes: [
    { id: "d1", type: "gel.dialogue", text: "车站很安静。" },
    { id: "end", type: "gel.end_story" },
  ],
  links: [
    ["entry", "out", "d1", "in"],
    ["d1", "next", "end", "in"],
  ],
} as const;

describe("authoring markdown", () => {
  it("parses scene frontmatter", () => {
    const doc = parseSceneMarkdown("---\nid: prologue\ntitle: 序章\nexits: [continue, retry]\n---\n\n# Goal\nMeet Alice.\n", "prologue");
    expect(doc).toEqual({ id: "prologue", title: "序章", exits: ["continue", "retry"], body: "# Goal\nMeet Alice.\n" });
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseSceneMarkdown("# no frontmatter\n")).toThrow(/frontmatter/);
  });

  it("rewrites context without touching the script body", () => {
    const source = "---\nid: prologue\ntitle: 序章\n---\n\n<!-- gel-context -->\nold\n<!-- /gel-context -->\n\n# Script\nKeep this.\n";
    const rewritten = rewriteContext(source, "neighbor: ending");
    expect(rewritten).toContain("neighbor: ending");
    expect(rewritten).toContain("# Script\nKeep this.\n");
    expect(splitContext(parseScriptMarkdown(rewritten).body).body).toContain("Keep this.");
  });
  it("parses outline as plain markdown", () => {
    expect(parseOutline("# 放课后\n\n四月开学。")).toEqual({ title: "放课后", body: "# 放课后\n\n四月开学。" });
  });

 
});

describe("authoring IR", () => {
  it("accepts a terminal narration scene", () => {
    expect(validateStoryIr({
      format: "gel.story-ir",
      formatVersion: 1,
      entryScene: "prologue",
      scenes: [validScene],
      routes: {},
    })).toEqual([]);
  });

  it("rejects a missing flow link", () => {
    const diagnostics = validateSceneIrFile({
      format: "gel.scene-ir",
      formatVersion: 1,
      ...validScene,
      links: [["entry", "out", "d1", "in"]],
    });
    expect(diagnostics.some((item) => item.code === "missing_flow_link")).toBe(true);
  });

  it("rejects dialogue with a speaker", () => {
    const diagnostics = validateSceneIrFile({
      format: "gel.scene-ir",
      formatVersion: 1,
      ...validScene,
      nodes: [
        { id: "d1", type: "gel.dialogue", text: "Hi", speaker: "alice" },
        { id: "end", type: "gel.end_story" },
      ],
    });
    expect(diagnostics.some((item) => item.code === "unsupported_speaker")).toBe(true);
  });

  it("rejects unsupported node types", () => {
    const diagnostics = validateSceneIrFile({
      format: "gel.scene-ir",
      formatVersion: 1,
      sceneId: "prologue",
      nodes: [{ id: "s1", type: "gel.stage" }],
      links: [],
    });
    expect(diagnostics.some((item) => item.code === "unsupported_node_type")).toBe(true);
  });
});

describe("authoring workspace", () => {
  it("inits and validates a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-"));
    const inited = await initAuthoring(dir);
    expect(inited.ok).toBe(true);
    expect(await readFile(join(dir, "outline.md"), "utf8")).toContain("Untitled Story");
    const validated = await validateAuthoring(dir);
    expect(validated.ok).toBe(true);
    expect(validated.scenes).toEqual([]);
  });

  it("reports invalid scene files during validate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "# missing frontmatter\n", "utf8");
    const validated = await validateAuthoring(dir);
    expect(validated.ok).toBe(false);
    expect(validated.diagnostics[0].code).toBe("missing_frontmatter");
  });

  it("replaces status.json without exposing torn JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-status-"));
    await writeStatus(dir, { state: "done", stage: "scenes", ok: true, message: "", diagnostics: [] });
    const writers = Array.from({ length: 30 }, (_, i) =>
      writeStatus(dir, { state: "running", stage: "scripts", ok: true, message: `n${i}`, diagnostics: [] }),
    );
    const readers = Array.from({ length: 30 }, async () => {
      JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    });
    await Promise.all([...writers, ...readers]);
  });
});

describe("author CLI", () => {
  it("runs init through authorMain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-cli-"));
    const code = await authorMain(["init", dir]);
    expect(code).toBe(0);
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as { state: string; ok: boolean };
    expect(status).toMatchObject({ state: "done", ok: true });
  });
});

describe("scene generation", () => {
  it("writes scene markdown from a mock LLM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-scenes-"));
    await initAuthoring(dir);
    const { generateScenes } = await import("../../src/author/stages");
    const result = await generateScenes(dir, {
      completeJson: async () => ({
        scenes: [{ id: "prologue", title: "序章", exits: ["continue"], body: "# Goal\nArrive." }],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.scenes).toEqual(["prologue"]);
    expect(await readFile(join(dir, "scenes", "prologue.md"), "utf8")).toContain("# Goal");
  });

  it("streams scene JSONL into markdown files as lines complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-scenes-stream-"));
    await initAuthoring(dir);
    const { generateScenes } = await import("../../src/author/stages");
    const first = JSON.stringify({ id: "prologue", title: "序章", exits: ["continue"], body: "# Goal\nArrive." });
    const second = JSON.stringify({ id: "ending", title: "结局", exits: [], body: "# Goal\nEnd." });
    const result = await generateScenes(dir, {
      completeJson: async () => ({ scenes: [] }),
      stream: async (_system, _user, onDelta) => {
        onDelta('{"id":"pro');
        await expect(readFile(join(dir, "scenes", "pro.md"), "utf8")).rejects.toThrow();
        onDelta(first.slice('{"id":"pro'.length, first.indexOf("Arrive")));
        expect(await readFile(join(dir, "scenes", "prologue.md"), "utf8")).toContain("# Goal");
        expect(await readFile(join(dir, "scenes", "prologue.md"), "utf8")).not.toContain('{"id"');
        onDelta(`${first.slice(first.indexOf("Arrive"))}\n`);
        onDelta(second.slice(0, second.indexOf("End")));
        expect(await readFile(join(dir, "scenes", "ending.md"), "utf8")).toContain("id: ending");
        onDelta(`${second.slice(second.indexOf("End"))}\n`);
        return `${first}\n${second}\n`;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.scenes).toEqual(["prologue", "ending"]);
    expect(await readFile(join(dir, "scenes", "prologue.md"), "utf8")).toContain("# Goal");
    expect(await readFile(join(dir, "scenes", "ending.md"), "utf8")).toContain("End.");
  });

  it("streams a script body into the markdown file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-script-stream-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Goal\nStart.\n", "utf8");
    const { generateScripts } = await import("../../src/author/stages");
    const result = await generateScripts(dir, "prologue", {
      completeJson: async () => ({ id: "prologue", title: "序章", body: "unused" }),
      stream: async (_system, _user, onDelta) => {
        onDelta("# Script\nThe station is quiet.");
        return "# Script\nThe station is quiet.";
      },
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, "scripts", "prologue.md"), "utf8")).toContain("The station is quiet.");
  });

  it("scripts scenes in parallel and keeps successes when one fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-scripts-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\nexits: [ending]\n---\n\n# Goal\nStart.\n", "utf8");
    await writeFile(join(dir, "scenes", "middle.md"), "---\nid: middle\ntitle: 中段\n---\n\n# Goal\nMiddle.\n", "utf8");
    await writeFile(join(dir, "scenes", "ending.md"), "---\nid: ending\ntitle: 结局\n---\n\n# Goal\nEnd.\n", "utf8");
    const { generateScripts } = await import("../../src/author/stages");
    const seen: string[] = [];
    const systems: string[] = [];
    const result = await generateScripts(dir, undefined, {
      completeJson: async (system, user) => {
        systems.push(system);
        seen.push(user);
        if (user.includes("Write script for scene ending")) throw new Error("boom");
        const id = user.includes("Write script for scene prologue") ? "prologue" : "middle";
        return { id, title: id, body: `# Script\n${id} line.` };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.scripts).toEqual(expect.arrayContaining(["prologue", "middle"]));
    expect(result.scripts).not.toContain("ending");
    expect(await readFile(join(dir, "scripts", "prologue.md"), "utf8")).toContain("prologue line");
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain("## ending (结局)");
    expect(seen.some((user) => user.includes("Write script for scene prologue"))).toBe(true);
  });

  it("patches a script once and stops when review is clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-review-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Goal\nStart.\n", "utf8");
    await writeFile(join(dir, "scripts", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Script\nOld.\n", "utf8");
    const { reviewScripts } = await import("../../src/author/stages");
    let reviews = 0;
    const result = await reviewScripts(dir, {
      completeJson: async (system, user) => {
        if (system.includes("review GEL")) {
          reviews += 1;
          if (reviews === 1) {
            return { findings: [{ sceneId: "prologue", severity: "error", kind: "logic", excerpt: "Old", suggestion: "Say the station is quiet." }] };
          }
          return { findings: [] };
        }
        expect(user).toContain("Review notes");
        return { id: "prologue", title: "序章", body: "# Script\nThe station is quiet." };
      },
    });
    expect(result.ok).toBe(true);
    expect(reviews).toBe(2);
    expect(await readFile(join(dir, "scripts", "prologue.md"), "utf8")).toContain("station is quiet");
    expect(await readFile(join(dir, "review", "findings.json"), "utf8")).toContain('"findings": []');
  });

  it("writes story IR from a mock LLM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-ir-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Goal\nStart.\n", "utf8");
    await writeFile(join(dir, "scripts", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Script\nQuiet station.\n", "utf8");
    const { generateIr } = await import("../../src/author/stages");
    const result = await generateIr(dir, undefined, {
      completeJson: async (system) => {
        if (system.includes("story graph")) return { entryScene: "prologue", routes: {} };
        return {
          nodes: [
            { id: "d1", type: "gel.dialogue", text: "The station is quiet." },
            { id: "end", type: "gel.end_story" },
          ],
          links: [["entry", "out", "d1", "in"], ["d1", "out", "end", "in"]],
        };
      },
    });
    expect(result.ok).toBe(true);
    const story = JSON.parse(await readFile(join(dir, "ir", "story.json"), "utf8")) as { entryScene: string; scenes: { links: unknown[] }[] };
    expect(story.entryScene).toBe("prologue");
    expect(story.scenes[0].links).toContainEqual(["d1", "next", "end", "in"]);
  });

  it("rewrites reserved enter exits to continue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-ir-enter-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\nexits: [enter]\n---\n\n# Goal\nStart.\n", "utf8");
    await writeFile(join(dir, "scenes", "ending.md"), "---\nid: ending\ntitle: 结局\n---\n\n# Goal\nEnd.\n", "utf8");
    await writeFile(join(dir, "scripts", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Script\nGo.\n", "utf8");
    await writeFile(join(dir, "scripts", "ending.md"), "---\nid: ending\ntitle: 结局\n---\n\n# Script\nBye.\n", "utf8");
    const { generateIr } = await import("../../src/author/stages");
    const result = await generateIr(dir, undefined, {
      completeJson: async (system, user) => {
        if (system.includes("story graph")) return { entryScene: "prologue", routes: { prologue: { enter: "ending" } } };
        if (user.includes("# Fill scene ending")) {
          return {
            nodes: [{ id: "end", type: "gel.end_story" }],
            links: [["entry", "out", "end", "in"]],
          };
        }
        return {
          nodes: [
            { id: "d1", type: "gel.dialogue", text: "Go on." },
            { id: "out", type: "gel.graph_output", interfaceId: "enter" },
          ],
          links: [["entry", "out", "d1", "in"], ["d1", "next", "out", "in"]],
        };
      },
    });
    expect(result.ok).toBe(true);
    const story = JSON.parse(await readFile(join(dir, "ir", "story.json"), "utf8")) as {
      routes: Record<string, Record<string, string>>;
      scenes: { sceneId: string; nodes: { type: string; interfaceId?: string }[] }[];
    };
    expect(story.routes.prologue).toEqual({ continue: "ending" });
    const outputs = story.scenes.find((scene) => scene.sceneId === "prologue")?.nodes.filter((node) => node.type === "gel.graph_output") ?? [];
    expect(outputs).toEqual([{ id: "out", type: "gel.graph_output", interfaceId: "continue" }]);
  });

  it("includes review/focus.txt when scripting a scene", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-focus-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Goal\nStart.\n", "utf8");
    await writeFile(join(dir, "review", "focus.txt"), "Make the station colder.\n", "utf8");
    const { generateScripts } = await import("../../src/author/stages");
    let prompt = "";
    const result = await generateScripts(dir, "prologue", {
      completeJson: async (_system, user) => {
        prompt = user;
        return { id: "prologue", title: "序章", body: "# Script\nCold station." };
      },
    });
    expect(result.ok).toBe(true);
    expect(prompt).toContain("Make the station colder.");
  });

  it("flushes IR scene events into stream.jsonl as each scene completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-ir-progressive-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "alpha.md"), "---\nid: alpha\ntitle: 甲\n---\n\n# Goal\nA.\n", "utf8");
    await writeFile(join(dir, "scenes", "beta.md"), "---\nid: beta\ntitle: 乙\n---\n\n# Goal\nB.\n", "utf8");
    await writeFile(join(dir, "scripts", "alpha.md"), "---\nid: alpha\ntitle: 甲\n---\n\n# Script\nA line.\n", "utf8");
    await writeFile(join(dir, "scripts", "beta.md"), "---\nid: beta\ntitle: 乙\n---\n\n# Script\nB line.\n", "utf8");
    const { generateIr } = await import("../../src/author/stages");
    let releaseBeta = (): void => undefined;
    const betaGate = new Promise<void>((resolve) => { releaseBeta = resolve; });
    const interior = (id: string): string => `${[
      { op: "node", id: "d1", type: "gel.dialogue", text: `${id} beat` },
      { op: "node", id: "end", type: "gel.end_story" },
      { op: "link", from: ["entry", "out"], to: ["d1", "in"] },
      { op: "link", from: ["d1", "next"], to: ["end", "in"] },
      { op: "done" },
    ].map((event) => JSON.stringify(event)).join("\n")}\n`;
    const run = generateIr(dir, undefined, {
      completeJson: async () => ({}),
      stream: async (system, user, onDelta) => {
        if (system.includes("lay out")) {
          onDelta(`${JSON.stringify({ op: "story", entryScene: "alpha" })}\n${JSON.stringify({ op: "done" })}\n`);
          return "";
        }
        const sceneId = user.includes("# Fill scene beta") ? "beta" : "alpha";
        if (sceneId === "beta") await betaGate;
        onDelta(interior(sceneId));
        return "";
      },
    });
    const jsonl = join(dir, "ir", "stream.jsonl");
    let streamed = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !streamed.includes("alpha beat")) {
      streamed = await readFile(jsonl, "utf8").catch(() => "");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    releaseBeta();
    const result = await run;
    expect(streamed).toContain("alpha beat");
    expect(result.ok).toBe(true);
  });

  it("writes graph routes into stream.jsonl after interiors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-ir-routes-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "alpha.md"), "---\nid: alpha\ntitle: 甲\nexits: [to-beta]\n---\n\n# Goal\nA.\n", "utf8");
    await writeFile(join(dir, "scenes", "beta.md"), "---\nid: beta\ntitle: 乙\n---\n\n# Goal\nB.\n", "utf8");
    await writeFile(join(dir, "scripts", "alpha.md"), "---\nid: alpha\ntitle: 甲\n---\n\n# Script\nA line.\n", "utf8");
    await writeFile(join(dir, "scripts", "beta.md"), "---\nid: beta\ntitle: 乙\n---\n\n# Script\nB line.\n", "utf8");
    const { generateIr } = await import("../../src/author/stages");
    let releaseScenes = (): void => undefined;
    const sceneGate = new Promise<void>((resolve) => { releaseScenes = resolve; });
    const interior = (id: string): string => `${(id === "alpha"
      ? [
          { op: "node", id: "out", type: "gel.graph_output", interfaceId: "to-beta" },
          { op: "link", from: ["entry", "out"], to: ["out", "in"] },
          { op: "done" },
        ]
      : [
          { op: "node", id: "end", type: "gel.end_story" },
          { op: "link", from: ["entry", "out"], to: ["end", "in"] },
          { op: "done" },
        ]
    ).map((event) => JSON.stringify(event)).join("\n")}\n`;
    const run = generateIr(dir, undefined, {
      completeJson: async () => ({}),
      stream: async (system, user, onDelta) => {
        if (system.includes("lay out")) {
          onDelta(`${[
            { op: "story", entryScene: "alpha" },
            { op: "route", from: "alpha", exit: "to-beta", to: "beta" },
            { op: "done" },
          ].map((event) => JSON.stringify(event)).join("\n")}\n`);
          return "";
        }
        await sceneGate;
        onDelta(interior(user.includes("# Fill scene beta") ? "beta" : "alpha"));
        return "";
      },
    });
    const jsonl = join(dir, "ir", "stream.jsonl");
    let streamed = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !streamed.includes('"op":"story"')) {
      streamed = await readFile(jsonl, "utf8").catch(() => "");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(streamed).not.toContain('"op":"route"');
    releaseScenes();
    const result = await run;
    streamed = await readFile(jsonl, "utf8");
    expect(streamed).toContain('"op":"route"');
    expect(result.ok).toBe(true);
  });

  it("pulses activity on streamed content deltas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-ir-activity-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "alpha.md"), "---\nid: alpha\ntitle: 甲\n---\n\n# Goal\nA.\n", "utf8");
    await writeFile(join(dir, "scripts", "alpha.md"), "---\nid: alpha\ntitle: 甲\n---\n\n# Script\nA line.\n", "utf8");
    const { generateIr } = await import("../../src/author/stages");
    const result = await generateIr(dir, undefined, {
      completeJson: async () => ({}),
      stream: async (system, _user, onDelta) => {
        if (system.includes("lay out")) {
          onDelta(`${JSON.stringify({ op: "story", entryScene: "alpha" })}\n`);
          await new Promise((resolve) => setTimeout(resolve, 250));
          onDelta(`${JSON.stringify({ op: "done" })}\n`);
          return "";
        }
        onDelta(`${[
          { op: "node", id: "end", type: "gel.end_story" },
          { op: "link", from: ["entry", "out"], to: ["end", "in"] },
          { op: "done" },
        ].map((event) => JSON.stringify(event)).join("\n")}\n`);
        return "";
      },
    });
    expect(result.ok).toBe(true);
    const activity = await readFile(join(dir, "activity"), "utf8");
    expect(activity.length).toBeGreaterThan(0);
  });
});
