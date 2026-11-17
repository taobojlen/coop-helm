#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
work=$(mktemp -d)
name="coop-otel-smoke-$$"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
chmod 777 "$work"
docker network create "$name" >/dev/null
docker volume create "$name" >/dev/null
docker run --rm -v "$name:/opt/coop-otel" "${OTEL_IMAGE:-coop-otel-instrumentation:local}" sh -ec 'cp -R /autoinstrumentation/node_modules /opt/coop-otel/; chmod -R a+rX /opt/coop-otel'
docker run -d --name "$name" --network "$name" \
  -v "$root/tests/fixtures/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  -v "$work:/data" otel/opentelemetry-collector-contrib:0.71.0 >/dev/null
for ratio in 0 1; do
  docker run --rm --network "$name" --user 1001 \
    -v "$name:/opt/coop-otel:ro" \
    -v "$root/files/otel-bootstrap.cjs:/opt/coop-otel-config/bootstrap.cjs:ro" \
    -v "$root/tests/fixtures/otel-smoke.mjs:/tmp/otel-smoke.mjs:ro" \
    -e NODE_OPTIONS='--require=/opt/coop-otel-config/bootstrap.cjs --experimental-loader=/opt/coop-otel/node_modules/@opentelemetry/instrumentation/hook.mjs' \
    -e OTEL_SERVICE_NAME="coop-verification-$ratio" \
    -e OTEL_EXPORTER_OTLP_ENDPOINT="http://$name:4317" \
    -e OTEL_TRACES_SAMPLER=parentbased_traceidratio \
    -e OTEL_TRACES_SAMPLER_ARG="$ratio" \
    -e OTEL_LOGS_EXPORTER=none \
    -e OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta \
    ghcr.io/roostorg/coop-server:1.2.0 node /tmp/otel-smoke.mjs
done
docker stop "$name" >/dev/null
node --input-type=module - "$work/telemetry.json" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
for (const ratio of [0, 1]) {
  const service = (r) => r.resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === `coop-verification-${ratio}`);
  const spans = rows.flatMap((r) => r.resourceSpans || []).filter(service).flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
  assert.equal(spans.some((s) => s.name === 'verification-root'), ratio === 1);
  assert(spans.some((s) => s.name === 'verification-parent-true'));
  assert(!spans.some((s) => s.name === 'verification-parent-false'));
  assert(!spans.some((s) => s.kind === 2 && s.attributes.some((a) => a.value.stringValue?.includes('/api/v1/ready'))));
  if (ratio === 1) {
    assert(spans.some((s) => s.kind === 2 && s.attributes.some((a) => a.key === 'http.route' && a.value.stringValue === '/verification')), 'HTTP/Express route span missing');
    assert(spans.some((s) => s.name === 'verification-handler' && s.parentSpanId), 'manual child span missing');
    assert(spans.some((s) => s.name === 'verification-draining'), 'recording stopped before application drain');
  }
  const metrics = rows.flatMap((r) => r.resourceMetrics || []).filter(service).flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
  const counter = metrics.find((m) => m.name === 'verification.items');
  assert(counter, 'unsampled metric missing');
  assert.equal(Number(counter.sum.dataPoints[0].asDouble ?? counter.sum.dataPoints[0].asInt), 7);
}
console.log('Collector verified: HTTP/Express and manual spans, parent sampling, readiness exclusion, unsampled metrics');
JS
