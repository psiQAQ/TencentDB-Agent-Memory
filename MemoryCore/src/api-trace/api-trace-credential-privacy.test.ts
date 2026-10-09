import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upstreamFixture } from "../metadata/service/upstream-group-test-fixture.js";
import { initApiTraceConfig, resetApiTraceConfigForTests } from "./api-log-config.js";
import { runWithApiRequestContext } from "./api-request-context.js";
import { logApiTrace } from "./api-trace-logger.js";
import { setStdoutWriterForTests } from "./api-trace-stdout.js";
import { wrapApiServiceForTrace } from "./api-traced-proxy.js";

describe("API trace credential privacy", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    setStdoutWriterForTests((line) => lines.push(line));
  });
  afterEach(() => {
    setStdoutWriterForTests(null);
    resetApiTraceConfigForTests();
  });

  it.each(["sqlite", "mongodb"] as const)("redacts the rejected business Key in %s service traces", (backend) => {
    initApiTraceConfig(backend);
    const fixture = upstreamFixture();
    const token = "uk_private_business_credential_for_trace_regression";
    try {
      const service = wrapApiServiceForTrace(fixture.service);
      expect(() => runWithApiRequestContext({ requestId: "privacy-test", module: "meta",
        route: "/v3/meta/instance-upstream/groups/list" }, () => service.assertCanManageUsers({
        token, userId: "business-user", isAdmin: false, isSystemAdmin: false,
      }))).toThrow("user management requires system admin");
      expect(lines.some((line) => JSON.parse(line).msg === "api.service.error")).toBe(true);
      expect(lines.join("")).not.toContain(token);
    } finally { fixture.cleanup(); }
  });

  it("redacts supplier and service credentials passed directly to the trace logger", () => {
    runWithApiRequestContext({ requestId: "privacy-test", module: "meta", route: "/internal" }, () => {
      logApiTrace("error", "api.remote.error", { api_key: "supplier-credential",
        authorization: "Bearer gateway-credential", token: "business-credential", success: false });
    });
    expect(lines).toHaveLength(1);
    for (const value of ["supplier-credential", "gateway-credential", "business-credential"])
      expect(lines[0]).not.toContain(value);
    expect(JSON.parse(lines[0]).success).toBe(false);
  });
});
