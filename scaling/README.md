# Worker autoscaling

This playground uses upstream KEDA 2.21.0 to scale Coop's unmodified BullMQ worker from the Redis waiting-list length. It keeps one worker running, adds a second under backlog, and waits five minutes before scaling down. The target is 1,000 waiting jobs per worker; the hard cap is two workers on the existing single node. This threshold is a scaling signal, not a queue size limit.

Install the operator, then the scaler:

```sh
helm upgrade --install keda keda --repo https://kedacore.github.io/charts \
  --version 2.21.0 --kube-context prosthetic-conscience \
  --namespace keda --create-namespace -f scaling/keda-values.yaml --wait
kubectl --context prosthetic-conscience apply -f scaling/worker-autoscaling.yaml
kubectl --context prosthetic-conscience -n coop get scaledobject,hpa
```

The manifest uses the existing `coop-secrets` Redis password and permits only KEDA operator pods to reach Redis through the Coop ingress policy. Adapt resource names, namespace, address, credentials, and TLS for other deployments. KEDA's operator watches only `coop`.

`worker.autoscaling.enabled: true` in `values-playground.yaml` omits the worker Deployment's replica count so future Helm upgrades leave replica management to the HPA. The scaler is installed separately; enabling this value alone does not install it. For a first installation, install KEDA before applying the scaler. To disable autoscaling, delete the ScaledObject, set the value to false, and explicitly set the desired worker replicas on the next Helm upgrade.

The playground also gives ClickHouse a 3 GiB memory limit after its previous 1.5 GiB limit caused OOM restarts. No database settings, worker concurrency, retention behavior, or Coop application code are changed. More workers cannot compensate indefinitely for database saturation; check processing throughput, failed jobs, database health, and node memory before increasing the cap. The injected instrumentation image is currently cached on this node, so additional nodes need that image made available too.

## Observed capacity blocker (2026-11-02)

Update: the container memory detection problem was addressed by upgrading the playground to official ClickHouse 26.8.36.3, with no server-setting overrides. See [upgrade and rollback notes](clickhouse-upgrade.md). The original diagnosis below is historical; the latest throughput result is in the upgrade notes.

Autoscaling successfully created two Ready workers and exposed a valid Redis metric through its HPA. However, ClickHouse 24.3.18.7 also OOM-restarted at the 3 GiB limit, before the second worker started. Its startup log reports `Disabling cgroup memory observer` because it cannot find the current-memory file. `system.server_settings` reports `max_server_memory_usage = 11293813555` (about 10.5 GiB), while `system.asynchronous_metrics` reports a 3 GiB cgroup limit. The internal budget therefore exceeds the container limit. No custom database override was added; investigate a supported upstream/container compatibility fix before treating worker scaling as a complete capacity solution. The first two-worker sample still grew, but a subsequent 45-second sample processed approximately 66 jobs/sec against 46 incoming posts/sec, reducing the waiting list from 74,582 to 73,717 without new failed jobs. This short improvement does not establish sustained stability given the observed OOM restart.
