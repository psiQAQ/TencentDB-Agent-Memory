import { expect, it } from "vitest";
import {
  accountSnapshot,
  catalogChoices,
  type Catalog,
  type CatalogModel,
} from "../web/src/lib/model-catalog.js";
import {
  canReuseModelKey,
  emptyModelDraft,
  modelWriteRequest,
} from "../web/src/lib/upstream-settings-form.js";

const publicModel: CatalogModel = {
  id: "m",
  name: "Public name",
  provider_id: "openai",
  protocols: ["openai-responses"],
  context_window: 20000,
  reasoning: true,
  sources: ["pi"],
};
const account: CatalogModel = {
  id: "m",
  name: "m",
  provider_id: "openai",
  protocols: ["openai-chat", "openai-responses"],
  reasoning: false,
  sources: ["account"],
};
const snapshot = {
  models: [account],
  revision: "r1",
  updated_at: "2026-10-11T00:00:00Z",
};
const catalog: Catalog = {
  public_catalog: { ...snapshot, models: [publicModel] },
  subscriptions: [],
  connections: [
    {
      group_id: "group",
      provider_id: "openai",
      credential_kind: "api_key",
      base_url: "https://api.openai.com/v1",
      snapshot,
    },
  ],
};
const draft = {
  ...emptyModelDraft(),
  provider: "openai" as const,
  group_id: "group",
  base_url: "https://api.openai.com/v1",
};

it("uses saved account results only for the same supplier, auth mode, URL, and unchanged key", () => {
  expect(accountSnapshot(catalog, draft)).toBe(snapshot);
  for (const patch of [
    { provider: "deepseek" as const },
    { credential_kind: "chatgpt_oauth" as const },
    { base_url: "https://different.invalid" },
    { api_key: "synthetic-new-key" },
    { group_id: "other" },
    { mode: "custom_passthrough" as const },
  ]) {
    expect(accountSnapshot(catalog, { ...draft, ...patch })).toBeUndefined();
  }
});
it("merges account capabilities with public metadata while preserving protocol restrictions and input state", () => {
  const before = structuredClone(draft);
  expect(catalogChoices([publicModel], [account], false)[0]).toMatchObject({
    name: "Public name",
    reasoning: false,
    context_window: 20000,
    protocols: ["openai-responses"],
    sources: ["account", "pi"],
  });
  expect(catalogChoices([publicModel], undefined, true)).toEqual([]);
  expect(
    catalogChoices(
      [publicModel],
      [{ ...account, protocols: ["openai-responses"], sources: ["chatgpt"] }],
      true,
    ),
  ).toHaveLength(1);
  expect(draft).toEqual(before);
});
it("retains selected removed models and never converts subscription credentials into an API key", () => {
  const subscription = {
    ...draft,
    model_id: "removed-model",
    credential_kind: "chatgpt_oauth" as const,
    credential_ref: "account",
    api_key: "synthetic-unused",
  };
  const saved = {
    configured: true,
    enabled: true,
    ...subscription,
    provider_id: "openai" as const,
    api_key_masked: "synthetic…",
  };
  expect(catalogChoices([], [], true)).toEqual([]);
  expect(subscription.model_id).toBe("removed-model");
  expect(
    canReuseModelKey({ ...draft, credential_kind: "api_key" }, saved),
  ).toBe(false);
  expect(modelWriteRequest(subscription).body).not.toHaveProperty("api_key");
  expect(modelWriteRequest(subscription).body).toMatchObject({
    credential_kind: "chatgpt_oauth",
    credential_ref: "account",
    model_id: "removed-model",
  });
});
