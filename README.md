# Coop Helm chart

> **Experimental and unofficial:** This is not an official Coop Helm chart. Validate it for your environment before deploying.

This chart deploys the Coop API, web frontend, item-processing worker, scheduled jobs, and optional single-instance PostgreSQL, Scylla, ClickHouse, and Redis services. Set each service's `enabled` value to `false` to use an external service instead.

The bundled topology is not highly available. It provides persistent volumes, authenticated PostgreSQL/ClickHouse/Redis, private Services, NetworkPolicies, resource budgets, and automatic upgrade migrations. Production operation also requires backups, restore exercises, monitoring, supported image versions, and capacity planning.

## Prerequisites

- Helm 3.14+ and Kubernetes 1.27+ with persistent volume provisioning.
- A CNI that enforces Kubernetes NetworkPolicy. Bundled Scylla has **no CQL authentication**; network isolation is its security boundary. Use external authenticated Scylla if this is insufficient.
- Approximately 6 GiB of requested memory, plus node and ingress overhead. Scylla reserves 4 GiB and has a 6 GiB limit. Review limits against actual node capacity and workload.
- A Secret in the release namespace containing `session-secret`, `postgresql-password`, `scylla-password`, `clickhouse-password`, and `redis-password`. Use strong, unique values from your secret manager. The Scylla password is used only with external authenticated Scylla.

Set `secrets.existingSecret` to that Secret's name. `secrets.keys` configures its key names. Never store credentials in values files. Keep the Secret stable across upgrades and restores. Changing a Secret does not rotate database credentials or restart running Pods; coordinate password rotation with the database and restart its consumers.

The default database images match this repository's Compose image families and versions. They are compatibility defaults, not a security certification. Review image advisories and support lifecycles before production deployment. Set immutable digest references for your approved images through `images` and each backing service's `image` value.

## Private Tailscale HTTPS

Install the [Tailscale Kubernetes Operator](https://tailscale.com/docs/kubernetes#setup) separately. Follow its [private Ingress guide](https://tailscale.com/kb/1439/kubernetes-operator-cluster-ingress). Configure MagicDNS, HTTPS certificates, operator OAuth credentials, device tags, and tailnet access policy. Keep OAuth credentials out of shell history and Helm values committed to Git.

`values-playground.yaml` uses ingress class `tailscale`, TLS hostname `coop`, and external URL `https://coop.example.ts.net`. The operator must run in namespace `tailscale`, or `networkPolicy.webIngressFrom` must be adjusted. Replace `externalUrl` with your own tailnet URL in an untracked `values-private.yaml` file and pass it after `-f values-playground.yaml` using `-f values-private.yaml`. The hostname must be available in your tailnet. Do not add `tailscale.com/funnel`; the chart does not enable Funnel, a public load balancer, host ports, or NodePorts.

TLS terminates at the operator proxy. Nginx forwards the request to the API with proxy headers. Coop runs with `NODE_ENV=production`, uses `UI_URL=externalUrl`, and its existing session middleware enables Secure cookies and proxy support. Only expose the web Service, not the API or databases. Verify login, Secure cookies, tailnet access controls, and rejection from outside the tailnet before using real data.

## Install and upgrade

Run the Helm commands from this chart's directory.

Create namespace `coop` and provision Secret `coop-secrets` before installation. The initial bootstrap starts only backing services and network policies. It does not run the application or migrations.

```sh copy Copy Bootstrap Command
helm install coop . --namespace coop \
  -f values-playground.yaml --set bootstrapOnly=true \
  --wait --timeout 15m
```

Complete the installation with an upgrade. Use this same command for subsequent upgrades; no separate migration step is needed.

```sh copy Copy Upgrade Command
helm upgrade coop . --namespace coop \
  -f values-playground.yaml --set bootstrapOnly=false \
  --wait --timeout 15m
```

Always supply the complete desired values. Do not use `--reuse-values` to select new chart defaults. Keep the API, web, worker, and migration images on a coherent Coop release. `Chart.appVersion` is informational; `images` selects the actual images.

Every application upgrade runs a blocking `pre-upgrade` Job using the target migration image and connection values. It creates missing databases/keyspaces and applies production migrations for PostgreSQL, Scylla, and ClickHouse in sequence. A failure stops the upgrade before application rollout. Successful hooks are deleted; failed hooks remain until the next attempt.

```sh copy Copy Migration Diagnostics
kubectl -n coop get jobs,pods
kubectl -n coop logs job/coop-coop-migrate
```

Resolve the error, then repeat the upgrade. Do not bypass the migration hook. A timeout or failed hook can leave partially applied migrations. Inspect database state before retrying. Old application Pods continue to run during migrations, so schema changes must support both application versions. Helm rollback does not undo database changes. Back up before upgrading and use forward fixes or a coordinated database restore when needed.

The hook connects to the existing databases before ordinary resources update. Stage database engine upgrades, endpoint changes, Secret changes, and network restrictions separately. A migration cannot require a database engine version that the same Helm upgrade has not started yet. Do not return an active installation to `bootstrapOnly=true`; that removes application resources.

Create your organization and administrator using Coop's [create-org utility](https://github.com/roostorg/coop/blob/main/server/bin/README.md). Production migrations do not replace organization provisioning. Configure email transport, sender addresses, and optional integration credentials through `extraEnv` (Kubernetes EnvVar entries, preferably Secret references). NCMEC defaults to test mode. HMA and other optional integration services are not bundled. Frontend build-time options require a separately built web image.

## External backing services

Disable only the services you manage externally. For example:

```yaml copy Copy External Services Values
postgresql:
  enabled: false
  host: postgres.database.svc.cluster.local
  readHost: postgres-replica.database.svc.cluster.local
  port: 5432
  database: coop
  username: coop
  ssl: true
clickhouse:
  enabled: false
  host: clickhouse.database.svc.cluster.local
  port: 8443
  protocol: https
  database: analytics
  username: coop
```

For external Scylla, set `enabled: false`, `host` (comma-separated contact points), `port`, `username`, `datacenter`, `keyspace`, and `replicationFactor`. The current migrator uses SimpleStrategy and does not expose CQL TLS settings; multi-datacenter replication and TLS-only Scylla require application/migrator changes. For external Redis, set `enabled: false`, `host`, `port`, `username`, and `tls`. Redis Cluster is not configured by this chart. PostgreSQL and ClickHouse TLS settings use the existing clients; private certificate authorities require additional client configuration.

Application and migrations share database credentials. They need the privileges required by the production migrations, including database/keyspace creation. Pre-provision these with a trusted administrator if the service restricts creation. Narrower application/migrator identities require a separate configuration change. Review the job schedules in `values.yaml` for your workload; they run in UTC with overlapping runs of the same CronJob forbidden.

Default schedules match those reported in [Coop issue #1198](https://github.com/roostorg/coop/issues/1198#issuecomment-5659231260): review-decision analytics refresh every five minutes, rule anomaly detection hourly, and NCMEC retries daily at 20:30 UTC. `RunUserRulesJob` and `RefreshUserScoresCacheJob` are not scheduled by default.

## Bluesky playground feed

`values-playground.yaml` enables a Jetstream consumer for the Working Hypothesis organization's **Bluesky Post** content type. The default chart values leave it disabled. The default endpoint is Microcosm's public European Jetstream (`wss://jetstream2.fr.hose.cam/subscribe`), listed by its operator as hosted in Germany. It uses the legacy Jetstream format. To use an official v2 endpoint, set both `jetstream.url` (for example `wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents`) and `jetstream.format: v2`. The consumer owns subscription filters and clears URL query parameters so it always requests all post records without a replay cursor.

The consumer forwards every valid new post it receives, including posts with empty text. It does not sample. It batches up to `jetstream.batchSize` items (default 100), checking for work every `jetstream.flushIntervalMs` (250 ms). One HTTP request can be in flight at a time. The in-memory buffer, including the in-flight batch, is capped at 1,000 items and 8 MiB of serialized payload; batches are capped at 512 KiB. Buffer limits exclude JavaScript object/string overhead. New arrivals are dropped when either buffer limit is reached. These limits are configurable and do not bound Coop's downstream Redis backlog.

Before upgrading, edit the existing **Bluesky Post** content type (`da23e732b62` in the playground). Keep the existing `authorDid` (String), `createdAt` (DateTime), `sourceUrl` (URL), and optional `languages` (String). Make `text` (String) optional. Add these optional fields with these exact names:

| Field           | Type            | Contents                                                 |
| --------------- | --------------- | -------------------------------------------------------- |
| `mediaUrls`     | Array of URL    | Full-size image URLs or video HLS playlist URLs          |
| `mediaAltTexts` | Array of String | Alt text aligned with each URL; empty string when absent |
| `mediaTypes`    | Array of String | `image` or `video`, aligned with each URL                |
| `externalUrl`   | URL             | HTTP(S) target of an embedded link card                  |

The three media arrays are always present (empty for posts without attachments). Use URL fields rather than Image/Video/Media fields to avoid enabling media processing during ingestion. The feeder derives Bluesky CDN URLs from author DIDs and blob CIDs; it does not download media or fetch profiles, quoted posts, or linked pages. Attached media on quote posts (`recordWithMedia`) is included, but media belonging to the quoted post is not. Link-card thumbnails and inline rich-text links are not extracted. Media URLs depend on Bluesky's CDN availability and are not an archive; videos may not be playable until transcoding completes. Video URLs are HLS playlists, not standalone MP4 files. Keep `createdAt` as the creation-time role. Configure rules separately; the feeder does not create rules, signals, or actions.

This is a live **best-effort feed**, not a lossless archive. Update/delete events are ignored. Reconnects start at the live edge without replay or backfill. Failed batches are dropped, including ambiguous network failures, and are never deliberately retried. Rate limits, server failures, and network failures trigger exponential backoff with jitter and honor `Retry-After` before sending later buffered posts. Other HTTP failures (including invalid credentials or schema mismatches) pause submissions until restart. Shutdown discards queued posts and lets an in-flight request finish within its deadline. Posts retain AT URIs as IDs, but upstream duplicates or ambiguous acceptance can still cause repeated processing; Coop does not provide submission idempotency.

Logs and health responses contain counters, not post bodies or credentials: `received`, `eligible`, `invalid`, `accepted`, `failedBatches`, `reconnects`, `droppedOverflow`, `droppedOversize`, `droppedFailure`, `droppedBlocked`, and `droppedShutdown`. They also expose buffered item/byte counts. Failed/ambiguous batches count as `droppedFailure` even if Coop actually accepted them; posts missed while disconnected cannot be counted. Counters reset on restart. `/readyz` requires an active stream and a recent HTTP 202, not completed worker processing. Monitor worker throughput, Redis queue depth, and database disk usage before deploying at full-feed volume; native retention does not guarantee that the existing storage can hold the full feed.

Local verification (does not deploy):

```sh
node --test tests/*.test.mjs
node --check files/jetstream.mjs
helm lint . -f values-playground.yaml
helm template coop . --is-upgrade --namespace coop -f values-playground.yaml > /tmp/coop-rendered.yaml
```

The feeder does not alter database retention or run queue cleanup. It uses Coop's
native behavior: Coop 1.2.0 initializes Scylla item storage with a 30-day default
TTL, and its ClickHouse migrations do not impose these item-specific TTLs. There
is no chart-level 24-hour retention setting. Completed worker jobs are removed by
Coop itself; failed-job retention follows Coop's worker configuration.

The API key comes from `jetstream.existingSecret` / `jetstream.apiKeySecretKey`. Coop 1.2.0 uses an organization-wide key, so this is not an ingestion-scoped credential. The container cannot read other keys from the referenced Secret. Rotate through Coop and update the Secret together, then restart the Deployment.

Use the explicit remote context from this machine:

```sh copy Copy Feed Diagnostics
kubectl --context prosthetic-conscience -n coop logs deployment/coop-coop-jetstream -c jetstream --tail=20
```

To stop ingestion persistently, set `jetstream.enabled: false` in `values-playground.yaml`, then run the usual Helm upgrade. For an immediate temporary stop:

```sh copy Copy Pause Feed
kubectl --context prosthetic-conscience -n coop scale deployment/coop-coop-jetstream --replicas=0
```

Scale it back to one replica to resume. A Helm upgrade with the feed enabled also restores that replica. On the k3s host, omit `--context prosthetic-conscience` if its kubeconfig uses a different context name.

## Storage and operations

Each bundled database uses one StatefulSet replica and an explicit PVC with `helm.sh/resource-policy: keep`. Set `<service>.storage.className` and `.size` before installation. `null` selects the cluster default; an empty string requests no storage class. The provisioner's reclaim policy and node-local storage limitations still apply. Increasing a value does not guarantee volume expansion; verify your storage class and filesystem support it.

Uninstall retains PVCs but does not back up data. Reinstall with the same release name, namespace, and credentials to reuse them. Disabling a bundled database retains its PVC; it does not copy data into the external database. Do not delete retained claims until you have verified backups and intend to destroy the data.

Use database-native backups for PostgreSQL, Scylla, and ClickHouse, plus Redis persistence/backups appropriate to your queue durability needs. Store backups off-node with encryption and retention. Restore all databases to a mutually consistent application version, then restore matching credentials and verify worker processing before accepting traffic. Node-local PVCs do not protect against node loss.

NetworkPolicy allows internal traffic within the release, operator-to-web ingress, and configurable application egress. Outbound application traffic is allowed by default for integrations and external databases. Restrict `networkPolicy.applicationEgress` for your environment, including DNS and migration access. Namespaces are trust boundaries: release labels are not protection against users who can create arbitrary Pods in that namespace.

The API readiness endpoint checks process health, not database health. Monitor migration failures, worker progress, queue depth, database/storage pressure, and backups separately. Database Pods retain image-required startup permissions; this chart does not claim compliance with the restricted Pod Security Standard.

## Verification

Static checks require no Kubernetes cluster:

```sh copy Copy Static Checks
helm lint . -f values-local.yaml --kubeconfig /dev/null
helm template coop-test . -f values-local.yaml \
  --set bootstrapOnly=true --kubeconfig /dev/null
helm template coop-test . -f values-local.yaml \
  --is-upgrade --kubeconfig /dev/null
```

The native Helm test Pod checks the web/API path and PostgreSQL, Redis, ClickHouse, and Scylla connectivity. It uses the configured credentials; bundled Scylla does not enforce authentication. Runtime tests need a cluster. To test on local OrbStack, provision namespace `coop-helm-test` and Secret `coop-test-secrets` there. Use the same bootstrap/upgrade sequence with `values-local.yaml` and explicitly select the local context:

```sh copy Copy OrbStack Commands
helm install coop-test . --kube-context orbstack -n coop-helm-test \
  -f values-local.yaml --set bootstrapOnly=true --wait --timeout 15m
helm upgrade coop-test . --kube-context orbstack -n coop-helm-test \
  -f values-local.yaml --set bootstrapOnly=false --wait --timeout 15m
helm test coop-test --kube-context orbstack -n coop-helm-test --logs
```

Repeat the upgrade and Helm tests to exercise an already-migrated database. Local values disable ingress and do not require the Tailscale operator. Local tests do not prove tailnet HTTPS, login, backup/restore, high availability, or public network isolation.

## Honeycomb performance telemetry (opt-in)

`observability.enabled` defaults to `false`. When enabled, only `coop-api` and
`coop-worker` receive an OpenTelemetry SDK. They export directly over OTLP/gRPC
with TLS to Honeycomb US. No cluster collector or feeder instrumentation is added.
Existing Coop spans and metrics become active alongside HTTP/Express, PostgreSQL,
Redis, outbound HTTP, and Node runtime instrumentation. Logs are not exported.

Create a Honeycomb environment (for example `coop`) and an **Ingest** key in the US
UI. Store the key in a Kubernetes Secret in Coop's namespace, with key `api-key`;
reference it with `observability.existingSecret`. Do not put it in values files.
The ingest key selects the Honeycomb environment; the `environment` value below
is a telemetry attribute, not an environment selector. No dataset header is used:
traces are separated by service name and metrics use native OTLP ingestion.

Build the dependency image from your Coop checkout, targeting your cluster's
architecture, then publish it to a registry your cluster can pull from. For example,
from this chart directory (replace the registry and tag):

```sh
# Local build only; publishing and deployment are separate steps.
docker build -f ../coop/nodejs-instrumentation/Dockerfile \
  -t YOUR_REGISTRY/coop-otel:YOUR_TAG ../coop
```

The image must provide SDK dependencies at `/autoinstrumentation/node_modules`,
including `@opentelemetry/instrumentation/hook.mjs`. The chart supplies its own
bootstrap rather than running Coop's AWS-specific bootstrap. Record the Coop source
revision used to build it, test that exact image, and use its published digest.

```yaml
observability:
  enabled: true
  instrumentationImage: YOUR_REGISTRY/coop-otel@sha256:YOUR_DIGEST
  endpoint: https://api.honeycomb.io:443
  existingSecret: coop-honeycomb
  environment: production
  api:
    traceSampleRatio: 0.01
  worker:
    traceSampleRatio: 0.01
```

Each service independently samples **new root traces** at its configured ratio
(0 disables roots, 1 retains all roots). Parent sampling decisions are preserved
where context propagates. This does not add propagation through BullMQ; worker jobs
can have separate traces. Head sampling can miss errors and slow requests. Metrics
are aggregated without trace sampling and exported every 60 seconds. Use metrics
for total throughput/error counts; raw sampled span counts are not total traffic.
Volume depends on spans per request and metric cardinality, so check Honeycomb usage
after enabling before increasing either rate.

Useful existing worker metrics include `coop-api.items.processing-attempts.counter`,
`coop-api.items.processing-failures.counter`, `coop-api.items.job-processing-time-ms.histogram`,
and `coop-api.items.queue-depth.histogram`. Their historical `coop-api` prefix also
appears in the worker service. Queue depth is recorded after successful processing,
so it does not continuously update during a stalled worker. HTTP latency metrics
and sampled traces show API routes and dependency timings.

Request bodies, SQL parameters, and Redis argument values are not added by this
bootstrap. SQL statement text, URLs, and attributes from Coop's existing manual
instrumentation can still appear. `NODE_OPTIONS`, `HONEYCOMB_API_KEY`, `OTEL_*`, and
`COOP_OTEL_*` are managed by this feature and cannot also be supplied in `extraEnv`.
Changing the Secret requires restarting API/worker Pods; changing configuration or
the bootstrap rolls them automatically on the next Helm upgrade.

Verify locally without Honeycomb credentials or a cluster deployment:

```sh
python3 tests/observability_test.py  # requires PyYAML and Helm
OTEL_IMAGE=coop-otel-instrumentation:local bash tests/otel-smoke.sh
```

The Docker smoke test uses the Coop 1.2.0 server runtime, the dependency image, and
a temporary local collector. It checks real trace/metric export, both sampler
extremes, parent decisions, HTTP/Express routing, and readiness exclusion. It does
not establish Honeycomb credentials, live application/database health, or API-to-job
trace propagation.

Telemetry export is best effort during shutdown: a signal triggers a flush while
Coop keeps draining. Coop calls `process.exit()` itself, so the final buffered
spans/metric points may be lost. Guaranteed final export needs an awaited SDK
shutdown hook in Coop; this chart does not change application exit behavior.

### Single-node deployment without a registry

For the playground, the instrumentation image can be loaded directly into k3s:

```sh
docker build --platform linux/amd64 \
  -f ../coop/nodejs-instrumentation/Dockerfile \
  -t coop-otel-instrumentation:20261102-amd64 ../coop
docker save coop-otel-instrumentation:20261102-amd64 | \
  ssh prosthetic-conscience 'sudo -n k3s ctr images import -'
```

This is a node-local image cache, not a registry. Load the image again if the node
is replaced or its unused image cache is pruned; load it on any additional nodes
before scheduling instrumented Pods there. A registry digest remains preferable
for a multi-node deployment.

The observability-only rollout uses targeted API/worker Deployment patches and the
OTel ConfigMap so pending feeder changes are not applied. These patches are not a
new Helm release revision. Use the updated playground values on the next intended
full Helm upgrade; do not roll back to old chart templates expecting instrumentation
to be retained. No feeder, retention, migration, or other workload is part of the
observability-only rollout.
