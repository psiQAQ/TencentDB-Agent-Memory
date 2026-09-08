import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { opikCreateLlmSpan, opikCreateTrace } from "../opik.js";
import { initTraceArchive, shutdownTraceArchive } from "../trace-archive.js";

it("applies the existing telemetry privacy boundary to the new local archive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "proxy-archive-privacy-"));
  const privateValue = "private-archive-sentinel";
  const config = structuredClone(DEFAULT_CONFIG);
  config.opik.enabled = false;
  initTraceArchive(directory, { enabled: true, dir: "." });
  try {
    opikCreateTrace(config, {
      traceId: "trace-test", name: privateValue, projectName: privateValue,
      startTime: new Date().toISOString(), input: { text: privateValue }, tags: [privateValue],
    });
    opikCreateLlmSpan(config, {
      traceId: "trace-test", name: privateValue, projectName: privateValue, model: privateValue,
      startTime: new Date().toISOString(), endTime: new Date().toISOString(),
      inputMessages: [{ role: "user", content: privateValue }],
      outputMessage: { role: "assistant", content: privateValue },
      usage: { prompt_tokens: 10, private: privateValue }, tags: [privateValue],
    });
    await shutdownTraceArchive();
    const contents = readdirSync(directory).map((file) => readFileSync(join(directory, file), "utf8")).join("");
    expect(contents.trim().split("\n")).toHaveLength(2);
    expect(contents).not.toContain(privateValue);
    expect(contents).toContain('"prompt_tokens":10');
  } finally {
    await shutdownTraceArchive();
    rmSync(directory, { recursive: true, force: true });
  }
});
