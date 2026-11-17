"use strict";

// Node also preloads NODE_OPTIONS in its ESM loader helper thread. That thread
// does not run Coop and must not create another SDK/runtime metrics exporter.
if (!require("node:worker_threads").isMainThread) {
  return;
}

// Resolve the separately mounted SDK without changing application module resolution.
const { createRequire } = require("node:module");
const otelRequire = createRequire(
  process.env.COOP_OTEL_PACKAGE_ROOT || "/opt/coop-otel/package.json",
);
const { NodeSDK } = otelRequire("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = otelRequire(
  "@opentelemetry/auto-instrumentations-node",
);
const { OTLPTraceExporter } = otelRequire(
  "@opentelemetry/exporter-trace-otlp-grpc",
);
const { OTLPMetricExporter } = otelRequire(
  "@opentelemetry/exporter-metrics-otlp-grpc",
);
const { PeriodicExportingMetricReader } = otelRequire(
  "@opentelemetry/sdk-metrics",
);
const { envDetector, processDetector } = otelRequire(
  "@opentelemetry/resources",
);

const { BatchSpanProcessor } = otelRequire("@opentelemetry/sdk-trace-base");

// Only enable the integrations needed for Coop performance. In particular, do not
// install log bridges or capture request bodies / Redis arguments / SQL parameters.
const enabled = new Set([
  "http",
  "express",
  "pg",
  "ioredis",
  "runtime-node",
  "undici",
]);
const instrumentations = getNodeAutoInstrumentations({
  "@opentelemetry/instrumentation-http": {
    ignoreIncomingRequestHook: (request) =>
      request.url?.split("?")[0] === "/api/v1/ready",
  },
  "@opentelemetry/instrumentation-pg": { enhancedDatabaseReporting: false },
  "@opentelemetry/instrumentation-ioredis": {
    dbStatementSerializer: (command) => command,
  },
}).filter((instrumentation) =>
  enabled.has(
    instrumentation.instrumentationName.replace(
      "@opentelemetry/instrumentation-",
      "",
    ),
  ),
);

// Report transport outcomes without logging telemetry contents or credentials.
function reportExports(exporter, signal) {
  const originalExport = exporter.export.bind(exporter);
  let confirmed = false;
  let lastFailure = 0;
  exporter.export = (data, callback) =>
    originalExport(data, (result) => {
      if (result.code === 0 && !confirmed) {
        confirmed = true;
        console.info(`OpenTelemetry ${signal}: first export accepted`);
      } else if (result.code !== 0 && Date.now() - lastFailure > 60000) {
        lastFailure = Date.now();
        console.error(
          `OpenTelemetry ${signal}: export failed (code ${result.code})`,
        );
      }
      callback(result);
    });
  return exporter;
}
const spanProcessor = new BatchSpanProcessor(
  reportExports(new OTLPTraceExporter(), "traces"),
);
const metricReader = new PeriodicExportingMetricReader({
  exporter: reportExports(new OTLPMetricExporter(), "metrics"),
  exportIntervalMillis: Number(
    process.env.OTEL_METRIC_EXPORT_INTERVAL || 60000,
  ),
});
const sdk = new NodeSDK({
  resourceDetectors: [envDetector, processDetector],
  spanProcessors: [spanProcessor],
  metricReaders: [metricReader],
  logRecordProcessors: [],
  instrumentations,
});
sdk.start();

// Coop drains requests/jobs in its own signal handlers, then calls process.exit.
// Flush what is buffered now but keep recording throughout that drain. A final
// guaranteed flush requires an awaited SDK hook in Coop itself; don't intercept
// process.exit or terminate the app from this preload.
const flush = () =>
  Promise.all([spanProcessor.forceFlush(), metricReader.forceFlush()]).catch(
    (error) => console.error("OpenTelemetry flush failed:", error.message),
  );
process.once("SIGTERM", flush);
process.once("SIGINT", flush);
let shutdown;
const stop = () =>
  (shutdown ??= sdk.shutdown().catch((error) => {
    console.error("OpenTelemetry shutdown failed:", error.message);
  }));
module.exports = { sdk, stop };
