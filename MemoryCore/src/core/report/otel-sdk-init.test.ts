import { afterEach, expect, it } from "vitest";
import { Server, ServerCredentials, type ServiceDefinition, type handleUnaryCall } from "@grpc/grpc-js";
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { initOTelSDK, shutdownOTelSDK } from "./otel-sdk-init.js";

let server: Server | undefined;
afterEach(async () => {
  await shutdownOTelSDK();
  trace.disable();
  logs.disable();
  server?.forceShutdown();
});

it("exports real OTLP traces and logs with configured gRPC authentication metadata", async () => {
  server = new Server();
  const received: Array<{ signal: string; authorization: unknown[]; bytes: number }> = [];
  for (const signal of ["trace", "logs"]) {
    const name = signal === "trace" ? "Trace" : "Logs";
    const service: ServiceDefinition = {
      Export: {
        path: `/opentelemetry.proto.collector.${signal}.v1.${name}Service/Export`,
        requestStream: false, responseStream: false,
        requestSerialize: (value: Buffer) => value,
        requestDeserialize: (value: Buffer) => value,
        responseSerialize: (value: Buffer) => value,
        responseDeserialize: (value: Buffer) => value,
      },
    };
    const handler: handleUnaryCall<Buffer, Buffer> = (call, callback) => {
      received.push({ signal, authorization: call.metadata.get("authorization"), bytes: call.request.length });
      callback(null, Buffer.alloc(0));
    };
    server.addService(service, { Export: handler });
  }
  const port = await new Promise<number>((resolve, reject) => {
    server!.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value));
  });
  expect(await initOTelSDK({
    endpoint: `http://127.0.0.1:${port}`, protocol: "grpc", serviceName: "core-typecheck-test",
    headers: { authorization: "Bearer local-test-token" }, clickhouse: false, langfuse: false,
  })).toBe(true);
  trace.getTracer("core-test").startSpan("typecheck-regression").end();
  logs.getLogger("core-test").emit({ body: "typecheck-regression" });
  await shutdownOTelSDK();
  expect(received.map((entry) => entry.signal).sort()).toEqual(["logs", "trace"]);
  for (const entry of received) {
    expect(entry.authorization).toEqual(["Bearer local-test-token"]);
    expect(entry.bytes).toBeGreaterThan(0);
  }
});
