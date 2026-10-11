import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderTdaiMemoryToolsBlock } from "../injection/injectors/tdai-tools-injector.js";

function executeRecipe(base: string, override?: string, session = "session-1"): string[] {
  const block = renderTdaiMemoryToolsBlock(base, session, "default", "codex");
  const recipe = block.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  expect(recipe).toBeDefined();
  // Execute the published shell recipe; intercept only the network boundary.
  const output = execFileSync("bash", ["--noprofile", "--norc", "-c", `curl() { printf '%s\\0' "$@"; }\n${recipe}`], {
    env: { PATH: process.env.PATH, TDAI_MEMORY_USER_KEY: "synthetic-business-key", ...(override ? { TDAI_PROXY_BASE_URL: override } : {}) },
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

describe("memory tool shell recipe", () => {
  it.each(["http://proxy:8096", "http://proxy:8096/"])("uses the client's complete base URL %s", (override) => {
    const args = executeRecipe("https://memory.example/proxy", override);
    expect(args).toContain("http://proxy:8096/memory-bridge/v3/atomic/search");
    expect(args).toContain("x-api-key: synthetic-business-key");
    expect(args).toContain("x-tdai-service-id: default");
    expect(args).toContain("x-tdai-agent-source: codex");
    expect(args).toContain("x-conversation-id: session-1");
  });

  it("preserves a configured LAN path prefix when no client override exists", () => {
    expect(executeRecipe("https://memory.example/proxy/")).toContain("https://memory.example/proxy/memory-bridge/v3/atomic/search");
  });

  it("treats configured URLs and identity headers as literal shell values", () => {
    expect(executeRecipe("https://memory.example/it's-proxy", undefined, "session's-id")).toEqual(expect.arrayContaining([
      "https://memory.example/it's-proxy/memory-bridge/v3/atomic/search",
      "x-conversation-id: session's-id",
    ]));
  });
});
