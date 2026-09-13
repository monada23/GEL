import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorMain } from "../../src/author/cli";
import {
  DEFAULT_AUTHOR_CONFIG,
  parseAuthorConfig,
  ConfigError,
} from "../../src/author/config";
import { clientForAgent } from "../../src/author/llm";

const valid = {
  providers: {
    openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
    local: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local-key" },
  },
  agents: {
    scenes: { provider: "openai", model: "gpt-4o" },
    scripts: { provider: "openai", model: "gpt-4o" },
    review: { provider: "local", model: "qwen2.5", reasoning: "low" },
    ir: { provider: "openai", model: "gpt-4o-mini" },
  },
};

const previous = process.env.GEL_AUTHOR_CONFIG;

afterEach(() => {
  if (previous === undefined) delete process.env.GEL_AUTHOR_CONFIG;
  else process.env.GEL_AUTHOR_CONFIG = previous;
});

describe("author config parse", () => {
  it("accepts providers and per-agent models", () => {
    expect(parseAuthorConfig(valid, "mem")).toEqual({
      providers: {
        openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
        local: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local-key" },
      },
      agents: valid.agents,
      maxConsecutiveErrors: 3,
    });
  });

  it("rejects a missing agent", () => {
    const { ir: _ir, ...agents } = valid.agents;
    expect(() => parseAuthorConfig({ ...valid, agents }, "mem")).toThrow(ConfigError);
    try {
      parseAuthorConfig({ ...valid, agents }, "mem");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_config" });
    }
  });

  it("rejects an unknown provider", () => {
    expect(() => parseAuthorConfig({
      ...valid,
      agents: { ...valid.agents, review: { provider: "missing", model: "x" } },
    }, "mem")).toThrow(/unknown/);
  });

  it("rejects unknown fields", () => {
    expect(() => parseAuthorConfig({ ...valid, extra: true }, "mem")).toThrow(/Unknown config field/);
  });

  it("rejects invalid reasoning", () => {
    expect(() => parseAuthorConfig({
      ...valid,
      agents: { ...valid.agents, review: { provider: "local", model: "qwen2.5", reasoning: "max" } },
    }, "mem")).toThrow(/reasoning/);
  });
});

describe("author config files", () => {
  it("builds a client from GEL_AUTHOR_CONFIG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-config-"));
    const path = join(dir, "author.config.json");
    await writeFile(path, `${JSON.stringify(valid)}\n`, "utf8");
    process.env.GEL_AUTHOR_CONFIG = path;
    const client = await clientForAgent("review");
    expect(client.provider).toBe("local");
    expect(client.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(client.model).toBe("qwen2.5");
    expect(client.apiKey).toBe("local-key");
    expect(client.reasoning).toBe("low");
  });

  it("writes a default config once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gel-author-config-init-"));
    const path = join(dir, "author.config.json");
    process.env.GEL_AUTHOR_CONFIG = path;
    expect(await authorMain(["config"])).toBe(0);
    const first = await readFile(path, "utf8");
    expect(JSON.parse(first)).toEqual(DEFAULT_AUTHOR_CONFIG);
    await writeFile(path, `${first.trim()}\n# keep\n`, "utf8");
    expect(await authorMain(["config"])).toBe(0);
    expect(await readFile(path, "utf8")).toBe(`${first.trim()}\n# keep\n`);
  });
});
