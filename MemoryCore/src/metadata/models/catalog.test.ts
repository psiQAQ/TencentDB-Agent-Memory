import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  supported,
  upstreamFixture,
} from "../service/upstream-group-test-fixture.js";
import { ModelCatalog } from "./catalog.js";
import {
  digest,
  discoverModels,
  mergeModel,
  parsePiCatalog,
  PI_CATALOG_URL,
} from "./providers.js";
import { sanitizeApiPayload } from "../../api-trace/api-sanitize.js";

const typed = (name = "Test") =>
  JSON.stringify({
    deepseek: [
      {
        id: "example",
        name,
        type: "chat",
        contextWindow: 2048,
        baseUrl: "https://attacker.invalid",
        headers: { Authorization: "never-use" },
      },
    ],
    openai: [],
    anthropic: [],
    google: [],
  });
const publicResponse = (raw = typed()) =>
  new Response(raw, {
    headers: { "x-pi-model-catalog-revision": digest(raw) },
  });
describe("model catalog persistence and isolation", () => {
  let f: ReturnType<typeof upstreamFixture>;
  beforeEach(() => {
    f = upstreamFixture();
  });
  afterEach(() => {
    f.cleanup();
  });
  it("validates revision and shape, discards execution metadata and non-chat models", () => {
    const raw = typed();
    expect(parsePiCatalog(raw, digest(raw))[0]).toMatchObject({
      id: "example",
      provider_id: "deepseek",
      context_window: 2048,
    });
    expect(JSON.stringify(parsePiCatalog(raw, digest(raw)))).not.toMatch(
      /attacker|Authorization|never-use/,
    );
    expect(() => parsePiCatalog(raw, digest("other"))).toThrow(
      "CATALOG_REVISION_MISMATCH",
    );
    expect(() => parsePiCatalog("{}", digest("{}"))).toThrow(
      "CATALOG_INVALID_PROVIDER",
    );
    const mixed = JSON.stringify({
      ...JSON.parse(raw),
      google: [{ id: "image", name: "Image", type: "image" }],
    });
    expect(parsePiCatalog(mixed, digest(mixed))).toHaveLength(1);
  });
  it("restores bundled then persisted snapshots while retaining partial refresh failures", async () => {
    const group = await f.service.createInstanceUpstreamCustomGroup(
      {
        name: "API",
        agents: [],
        mode: "custom_unified",
        provider_id: "deepseek",
        base_url: "https://api.deepseek.com",
        api_key: "synthetic-provider-key",
        model_id: "saved-model",
      },
      supported,
    );
    const before = f.store.getInstanceUpstreamGroup(String(group.group_id));
    let offline = false;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (offline) throw new Error("secret-remote-diagnostics");
      if (String(input) === PI_CATALOG_URL) {
        expect(JSON.stringify(init)).not.toContain("synthetic-provider-key");
        return publicResponse();
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-provider-key",
      );
      return Response.json({ data: [{ id: "account-model" }] });
    });
    const service = new ModelCatalog(f.store, fetcher);
    expect((await service.list()).public_catalog.models.length).toBeGreaterThan(
      50,
    );
    expect((await service.refresh()).status).toBe("succeeded");
    offline = true;
    f.store.close();
    f.store.init();
    const restored = new ModelCatalog(f.store, fetcher);
    expect((await restored.list()).public_catalog.models[0].id).toBe("example");
    const result = await restored.refresh();
    expect(result.status).toBe("failed");
    expect(
      result.results.every(
        (r) => !!r.updated_at && r.error === "MODEL_SOURCE_UNAVAILABLE",
      ),
    ).toBe(true);
    expect((await restored.list()).connections[0].snapshot?.models[0].id).toBe(
      "account-model",
    );
    expect(f.store.getInstanceUpstreamGroup(String(group.group_id))).toEqual(
      before,
    );
    expect(JSON.stringify(result)).not.toMatch(/synthetic|secret-remote/);
  });
  it("coalesces concurrent refresh and reports a failed account independently", async () => {
    await f.service.createInstanceUpstreamExtraction(
      {
        base_url: "https://api.deepseek.com",
        api_key: "synthetic",
        model_id: "m",
      },
      supported,
    );
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url) === PI_CATALOG_URL
        ? publicResponse()
        : new Response(null, { status: 401 }),
    );
    const service = new ModelCatalog(f.store, fetcher);
    const [left, right] = await Promise.all([
      service.refresh(),
      service.refresh(),
    ]);
    expect(left).toEqual(right);
    expect(left.status).toBe("partial");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not persist a draft key or share old account caches after key rotation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: "private-account-model" }] }),
    );
    const service = new ModelCatalog(f.store, fetcher);
    const draft = await service.discover({
      provider_id: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "synthetic-draft",
    });
    expect(draft.persisted).toBe(false);
    expect(f.store.listModelStates("account:")).toEqual([]);
    const group = await f.service.createInstanceUpstreamCustomGroup(
      {
        name: "API",
        agents: [],
        mode: "custom_unified",
        provider_id: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "synthetic-old",
        model_id: "saved",
      },
      supported,
    );
    await service.discover({ group_id: String(group.group_id) });
    expect((await service.list()).connections[0].snapshot?.models).toHaveLength(
      1,
    );
    await f.service.updateInstanceUpstreamGroup(
      {
        group_id: String(group.group_id),
        group_type: "custom",
        api_key: "synthetic-new",
      },
      supported,
    );
    expect((await service.list()).connections[0].snapshot).toBeNull();
    await expect(
      service.discover({
        group_id: String(group.group_id),
        base_url: "https://api.deepseek.com",
      }),
    ).rejects.toThrow("MODEL_CREDENTIALS_CHANGED");
    expect(JSON.stringify(f.store.listModelStates("account:"))).not.toMatch(
      /synthetic-(draft|old|new)/,
    );
  });
  it("keeps missing account capability values unknown and lets explicit account metadata win", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: [
          { id: "example", context_window: 4096, reasoning: false },
          { id: "new" },
        ],
      }),
    );
    const models = await discoverModels(
      "deepseek",
      "key",
      "https://api.deepseek.com",
      false,
      fetcher,
    );
    expect(
      mergeModel(models[0], parsePiCatalog(typed(), digest(typed()))),
    ).toMatchObject({ name: "Test", context_window: 4096, reasoning: false });
    expect(models[1].context_window).toBeUndefined();
    expect(models[1].reasoning).toBeUndefined();
    await expect(
      discoverModels(
        "deepseek",
        "key",
        "https://attacker.invalid",
        false,
        fetcher,
      ),
    ).rejects.toThrow("OFFICIAL_ENDPOINT");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("follows Anthropic cursors and fails repeated or missing pagination cursors", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
      return Response.json(
        calls.length === 1
          ? { data: [{ id: "a" }], has_more: true, last_id: "a" }
          : { data: [{ id: "b" }], has_more: false },
      );
    });
    expect(
      (
        await discoverModels(
          "anthropic",
          "key",
          "https://api.anthropic.com/v1",
          false,
          fetcher,
        )
      ).map((m) => m.id),
    ).toEqual(["a", "b"]);
    expect(calls[1]).toContain("after_id=a");
    const loop = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [], has_more: true, last_id: "same" }),
    );
    await expect(
      discoverModels(
        "anthropic",
        "key",
        "https://api.anthropic.com/v1",
        false,
        loop,
      ),
    ).rejects.toThrow("MODEL_INVALID_PAGINATION");
  });
  it("retains Anthropic capabilities and Gemini original IDs through pagination", async () => {
    const anthropic = await discoverModels(
      "anthropic",
      "key",
      "https://api.anthropic.com/v1",
      false,
      async () =>
        Response.json({
          data: [
            {
              id: "claude",
              display_name: "Claude",
              max_input_tokens: 1000,
              max_tokens: 200,
              capabilities: {
                thinking: { supported: true },
                vision: { supported: false },
              },
              lifecycle: "retired",
            },
          ],
          has_more: false,
        }),
    );
    expect(anthropic[0]).toMatchObject({
      max_input_tokens: 1000,
      max_output_tokens: 200,
      reasoning: true,
      capabilities: { thinking: true, vision: false },
      lifecycle: "retired",
    });
    const calls: string[] = [];
    const gemini = await discoverModels(
      "gemini",
      "key",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      false,
      async (url, init) => {
        calls.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer key",
        );
        return Response.json(
          calls.length === 1
            ? { data: [{ id: "models/gemini-one" }], nextPageToken: "page-two" }
            : { data: [{ id: "gemini-two" }] },
        );
      },
    );
    expect(gemini.map((model) => model.id)).toEqual([
      "models/gemini-one",
      "gemini-two",
    ]);
    expect(calls[1]).toContain("pageToken=page-two");
  });
  it("supports the documented DeepSeek v1 alias and keeps explicit reasoning effort metadata", async () => {
    const models = await discoverModels(
      "deepseek",
      "key",
      "https://api.deepseek.com/v1",
      false,
      async (url) => {
        expect(String(url)).toBe("https://api.deepseek.com/models");
        return Response.json({
          data: [
            {
              id: "deepseek",
              effort: { supported_levels: ["high"] },
              api_capabilities: {
                anthropic_messages: { system_prompt_update: "append" },
              },
            },
          ],
        });
      },
    );
    expect(models[0]).toMatchObject({
      reasoning: true,
      effort_levels: ["high"],
      system_prompt_update: "append",
    });
  });
  it("distinguishes ChatGPT account models from the API model schema and preserves visible order", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        models: [
          { slug: "z", display_name: "Z", visibility: "list" },
          { slug: "a", visibility: "hidden" },
          { slug: "b", visibility: "list" },
        ],
      }),
    );
    expect(
      (
        await discoverModels(
          "openai",
          "token",
          "https://api.openai.com/v1",
          true,
          fetcher,
        )
      ).map((m) => m.id),
    ).toEqual(["z", "b"]);
    await expect(
      discoverModels(
        "openai",
        "key",
        "https://api.openai.com/v1",
        false,
        fetcher,
      ),
    ).rejects.toThrow("MODEL_INVALID_RESPONSE");
  });
  it("atomically compares state versions and redacts OAuth material", () => {
    expect(f.store.setModelState("catalog:test", "a", 0)?.version).toBe(1);
    expect(f.store.setModelState("catalog:test", "b", 0)).toBeNull();
    expect(f.store.setModelState("catalog:test", "b", 1)?.version).toBe(2);
    expect(f.store.getModelState("catalog:test")?.value).toBe("b");
    expect(
      sanitizeApiPayload(
        {
          access_token: "synthetic",
          refresh_token: "synthetic",
          id_token: "synthetic",
          authorization_url: "synthetic",
          authorization_code: "synthetic",
        },
        100,
      ),
    ).toEqual({
      access_token: "[redacted]",
      refresh_token: "[redacted]",
      id_token: "[redacted]",
      authorization_url: "[redacted]",
      authorization_code: "[redacted]",
    });
  });
});
