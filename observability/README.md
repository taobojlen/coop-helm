# Coop Kubernetes metrics

A separate OpenTelemetry Collector DaemonSet follows Honeycomb's Kubernetes
pipeline guidance with a smaller scope for the Free plan. It reads kubelet pod
stats every 60 seconds, keeps six metrics for Coop's API, worker, web and backing
databases, and sends native OTLP metrics to Honeycomb US as `coop-kubernetes`.
It does not collect application logs, Kubernetes events, node-wide metrics, feeder
metrics, arbitrary pod labels/annotations, or application traces. The existing
application SDKs keep exporting directly.

Pinned chart: `opentelemetry-collector` 0.178.1. Pinned image: 0.163.2.
The `coop-honeycomb` Secret must already exist in namespace `coop`.
Kubelet TLS verification stays enabled, and RBAC grants only `get nodes/stats`.
This reads the node's stats before filtering; only the allowlisted Coop pods and
metrics leave the collector. No host mounts, host ports, or write permissions.

```sh
helm upgrade --install coop-k8s-metrics opentelemetry-collector \
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \
  --version 0.178.1 --kube-context prosthetic-conscience --namespace coop \
  -f observability/kubernetes-values.yaml --wait --timeout 5m
```

This separate release does not update Coop's Helm release or its workloads.
To remove only this collector:

```sh
helm uninstall coop-k8s-metrics --kube-context prosthetic-conscience -n coop
```

Metrics:

- `k8s.pod.memory.working_set`: pod working-set memory in bytes; useful alongside `kubectl top`.
- `k8s.pod.memory.usage`: total usage, including reclaimable cache.
- `k8s.pod.memory.rss`: resident memory.
- `k8s.pod.cpu.usage`: CPU usage in cores.
- `k8s.pod.cpu.time`: cumulative CPU seconds.
- `k8s.pod.uptime`: pod uptime in seconds.

At seven steady pods this is at most 42 points per minute, or 1,814,400 points
per 30 days (about 1.8% of the current 100M Free monthly metric allowance).
Rollouts/replicas increase the count; temporary missing kubelet stats reduce it.
This estimate excludes the application SDKs' metrics and traces. Native metric
points do not consume the separate 20M event allowance. Keep track of total
account usage in Honeycomb; this configuration is not an account-wide budget cap.

The collector exposes internal counters on pod port 8888, accessible for local
inspection with `kubectl port-forward`, without exporting its self-metrics.
Check sent/failed metric point counters and the filter drop count after upgrades.
No persistent export queue is provisioned; retry buffering is bounded in memory.

References:
- https://docs.honeycomb.io/send-data/kubernetes/opentelemetry/create-telemetry-pipeline
- https://www.honeycomb.io/pricing

## Verified deployment (2026-11-02)

Release `coop-k8s-metrics`, revision 2, is deployed and Ready. The first collection
exported 35 points (CPU usage needs a baseline); the next exported 42. Honeycomb
acknowledged 77 cumulative points with zero scrape errors or refused points.
407 other points were filtered out over those collections. Thus the observed
steady rate matches the 1.8144M/month estimate above. Existing API, worker and
feeder pod UIDs and restart counts were unchanged. The collector filter was also
exercised locally with synthetic OTLP data (`python3 observability/test-filter.py`).

## Workload health and Kubernetes events

`workload-health-values.yaml` adds a separate singleton Deployment. Unlike the
per-node resource collector, this runs once per cluster (Recreate upgrades avoid
brief double collection). It collects these ten metrics every 60 seconds in
namespace `coop`:

- `k8s.container.restarts`, `k8s.pod.phase`
- `k8s.daemonset.current_scheduled_nodes`, `k8s.daemonset.desired_scheduled_nodes`
- `k8s.statefulset.desired_pods`, `k8s.statefulset.ready_pods`
- `k8s.deployment.available`, `k8s.deployment.desired`
- `k8s.job.failed_pods`, `k8s.cronjob.active_jobs`

It watches Normal and Warning core/v1 Kubernetes events for the Coop namespace,
plus Node events for `prosthetic-conscience` across namespaces. The two watches
exclude overlap. Deleted/watch-bookmark/error notifications are not exported as
lifecycle events. Kubernetes Events can be updated and aggregated: log record
counts are not necessarily unique incident counts; `event.count` is retained.
No application log files are collected. Metrics route natively; lifecycle events
route to the `k8s-events` log dataset. The receiver has no persistent watch cursor,
so restarts can replay retained events or miss events during downtime.

The namespace-wide workload observer includes Coop jobs and the collectors' own
health; it does not modify or instrument those applications. A namespace Role
provides the cluster receiver's read permissions; an events-only ClusterRole
supports node-event discovery across namespaces. No Secrets read or Kubernetes
write permissions are granted.

```sh
helm upgrade --install coop-k8s-health opentelemetry-collector \
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \
  --version 0.178.1 --kube-context prosthetic-conscience --namespace coop \
  -f observability/workload-health-values.yaml --wait --timeout 3m
python3 observability/test-workload-health.py
```

Update the node-event selector if this cluster's node is renamed or expanded.
Metric costs scale with retained workloads and replicas, including completed Jobs
until Kubernetes deletes them. Event ingestion depends on lifecycle activity and
repeated event updates, not Bluesky posts. Metrics use the Free metric allowance;
event records use the event allowance shared with application traces.

### Honeycomb board compatibility

The raw signals required by Kubernetes Workload Health are now configured. The
Honeycomb template also lists calculated helpers (`container_restarts_per_sec`,
`daemonset_unready_pods`, `statefulset_undeployed_pods`, and
`deployment_undeployed_pods`). These are query-side calculations, not raw Kubernetes
measurements. Template queries may need adaptation to native metrics/query math;
do not switch native metrics to legacy event ingestion solely to make an old
calculated-field query work. The ingest credential cannot create or inspect boards
or calculated fields, so this deployment does not claim all 11 template queries
are automatically enabled. Event fields only appear once matching events arrive.

### Workload observer verification (2026-11-02)

Release `coop-k8s-health`, revision 1, is deployed and Ready. The first steady
scrape exported 59 workload-health points (about 2,548,800 per 30 days at that
workload count). Together with 42/min resource points this is about 4,363,200/month,
excluding application telemetry and future workload churn. A subsequent scrape
included a temporary verification Job and exported 62 points. Honeycomb accepted
121 cumulative metric points and six Normal lifecycle event records with no
reported export errors/refusals. The verification Job performed a read-only
namespace-pod API request with the observer's service account, passed, and was
deleted. Existing API, worker and feeder pods/restarts were unchanged.

Normal/Warning and node/pod event field mapping was verified locally; no fake
Warning or Node event was injected into Kubernetes. Live warning/node-event
queries will populate as those events occur. The live watch began with new events;
this setup does not promise historical event backfill. Board availability was not
verified with the ingest-only Honeycomb credential.
