import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
const appRequire = createRequire("/app/server/package.json");
const { trace, metrics, context, TraceFlags } =
  appRequire("@opentelemetry/api");
const express = appRequire("express");
const { stop } = appRequire("/opt/coop-otel-config/bootstrap.cjs");
const tracer = trace.getTracer("coop-chart-smoke");
const root = tracer.startSpan("verification-root");
assert.equal(root.isRecording(), process.env.OTEL_TRACES_SAMPLER_ARG === "1");
root.end();
for (const sampled of [false, true]) {
  const parent = trace.setSpanContext(context.active(), {
    traceId: "12345678901234567890123456789012",
    spanId: sampled ? "1234567890123456" : "2234567890123456",
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
  const child = tracer.startSpan(`verification-parent-${sampled}`, {}, parent);
  assert.equal(child.isRecording(), sampled);
  child.end();
}
metrics.getMeter("coop-chart-smoke").createCounter("verification.items").add(7);
const app = express();
app.get("/verification", (_req, res) => {
  tracer.startActiveSpan("verification-handler", (span) => {
    res.json({ ok: true });
    span.end();
  });
});
app.get("/api/v1/ready", (_req, res) => res.end("ready"));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
for (const path of ["/verification", "/api/v1/ready"]) {
  await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${server.address().port}${path}`, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject);
  });
}
await new Promise((resolve) => server.close(resolve));
// Simulate Coop continuing to work after its graceful-shutdown signal.
process.emit("SIGTERM");
const draining = tracer.startSpan("verification-draining");
assert.equal(
  draining.isRecording(),
  process.env.OTEL_TRACES_SAMPLER_ARG === "1",
);
draining.end();
const helper = new Worker(
  `
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage(Boolean(require('/opt/coop-otel-config/bootstrap.cjs').sdk));
`,
  { eval: true },
);
assert.equal(
  await new Promise((resolve, reject) => {
    helper.once("message", resolve);
    helper.once("error", reject);
  }),
  false,
  "helper thread must not start a duplicate SDK",
);
await helper.terminate();
await stop();
console.log("SDK smoke checks passed");
