import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consumeJsonLines, foldIrEvents, readSseContent } from "../../src/author/stream";
import { validateStoryIr } from "../../src/author/ir";
import { generateIr } from "../../src/author/stages";
import { initAuthoring } from "../../src/author/workspace";
import { writeFile } from "node:fs/promises";

function sseChunk(text: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n`;
 }

describe("SSE and IR events", () => {
  it("assembles tokens split across SSE chunks", async () => {
    const events = [
      { op: "story", entryScene: "prologue" },
      { op: "scene", sceneId: "prologue", title: "序章" },
      { op: "node", id: "d1", type: "gel.dialogue", text: "Quiet." },
      { op: "node", id: "end", type: "gel.end_story" },
      { op: "link", from: ["entry", "out"], to: ["d1", "in"] },
      { op: "link", from: ["d1", "next"], to: ["end", "in"] },
      { op: "done" },
    ];
    const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const mid = Math.floor(jsonl.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseChunk(jsonl.slice(0, mid))));
        controller.enqueue(new TextEncoder().encode(sseChunk(jsonl.slice(mid))));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n"));
        controller.close();
      },
    });
    const text = await readSseContent(stream, () => undefined);
    let pending = "";
    const parsed: unknown[] = [];
    pending = consumeJsonLines(text, (value) => parsed.push(value));
    if (pending.trim()) parsed.push(JSON.parse(pending.trim()));
    const story = foldIrEvents(parsed);
    expect(validateStoryIr(story)).toEqual([]);
    expect(story.entryScene).toBe("prologue");
  });

  it("rejects a link to a node that has not been emitted", () => {
    expect(() => foldIrEvents([
      { op: "story", entryScene: "prologue" },
      { op: "scene", sceneId: "prologue" },
      { op: "link", from: ["entry", "out"], to: ["d1", "in"] },
      { op: "done" },
    ])).toThrow(/already exist/);
  });

  it("reopens a scene stub to add nodes", () => {
    const story = foldIrEvents([
      { op: "scene", sceneId: "prologue", title: "序章" },
      { op: "story", entryScene: "prologue" },
      { op: "scene", sceneId: "prologue" },
      { op: "node", id: "d1", type: "gel.dialogue", text: "Quiet." },
      { op: "node", id: "end", type: "gel.end_story" },
      { op: "link", from: ["entry", "out"], to: ["d1", "in"] },
      { op: "link", from: ["d1", "next"], to: ["end", "in"] },
      { op: "done" },
    ]);
    expect(story.scenes).toHaveLength(1);
    expect(story.scenes[0].nodes).toHaveLength(2);
  });

  it("retries after an IR event error and keeps accepted events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-stream-retry-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Goal\nStart.\n", "utf8");
    await writeFile(join(dir, "scripts", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Script\nQuiet.\n", "utf8");
    let sceneCalls = 0;
    const result = await generateIr(dir, undefined, {
      completeJson: async () => ({ format: "nope" }),
      stream: async (system, _user, onDelta, extra) => {
        if (system.includes("story graph")) {
          const text = `${JSON.stringify({ op: "story", entryScene: "prologue" })}\n${JSON.stringify({ op: "done" })}\n`;
          onDelta(text);
          return text;
        }
        sceneCalls += 1;
        const first = `${JSON.stringify({ op: "link", from: ["entry", "out"], to: ["missing", "in"] })}\n`;
        const rest = `${JSON.stringify({ op: "node", id: "d1", type: "gel.dialogue", text: "Quiet." })}\n${JSON.stringify({ op: "node", id: "end", type: "gel.end_story" })}\n${JSON.stringify({ op: "link", from: ["entry", "out"], to: ["d1", "in"] })}\n${JSON.stringify({ op: "link", from: ["d1", "next"], to: ["end", "in"] })}\n`;
        const text = extra !== undefined && extra.length > 0 ? rest : first;
        onDelta(text);
        return text;
      },
    });
    expect(result.ok).toBe(true);
    expect(sceneCalls).toBe(2);
    expect(JSON.parse(await readFile(join(dir, "ir", "story.json"), "utf8")).entryScene).toBe("prologue");
  });

  it("stops after 3 consecutive IR errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-stream-stop-"));
    await initAuthoring(dir);
    await writeFile(join(dir, "scenes", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Goal\nStart.\n", "utf8");
    await writeFile(join(dir, "scripts", "prologue.md"), "---\nid: prologue\ntitle: 序章\n---\n\n# Script\nQuiet.\n", "utf8");
    let sceneCalls = 0;
    const result = await generateIr(dir, undefined, {
      completeJson: async () => ({ format: "nope" }),
      stream: async (system, _user, onDelta) => {
        if (system.includes("story graph")) {
          const text = `${JSON.stringify({ op: "story", entryScene: "prologue" })}\n${JSON.stringify({ op: "done" })}\n`;
          onDelta(text);
          return text;
        }
        sceneCalls += 1;
        const line = `${JSON.stringify({ op: "link", from: ["entry", "out"], to: ["missing", "in"] })}\n`;
        onDelta(line);
        return line;
      },
    });
    expect(result.ok).toBe(false);
    expect(sceneCalls).toBe(3);
    expect(result.diagnostics[0].message).toMatch(/3 consecutive errors/);
    await expect(readFile(join(dir, "ir", "story.json"), "utf8")).rejects.toThrow();
  });
});
