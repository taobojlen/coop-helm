# ClickHouse container memory fix

The playground's official ClickHouse 24.3.18.7 image failed to initialize its cgroup memory observer on this k3s node. It set `max_server_memory_usage` to 11,293,813,555 bytes despite the container's 3 GiB limit and repeatedly suffered OOM kills.

An isolated pod running official `clickhouse/clickhouse-server:26.8.36.3` with a 1 GiB memory limit correctly calculated an internal budget of 966,367,641 bytes (90%). All three Coop ClickHouse SQL migrations ran successfully against its empty database, creating 25 application tables. The temporary pod had no access to the production volume and denied network ingress/egress.

The playground pins this newer LTS image in `values-playground.yaml`. The chart default still follows Coop's 24.3 image. No custom ClickHouse server settings, TTLs, or application changes are involved. This deployment uses a chart-managed StatefulSet, not a ClickHouse operator.

Before the live upgrade, KEDA worker scaling was paused at zero, ClickHouse was stopped, and its complete data directory was copied on the node to `/var/backups/coop-clickhouse-20261102/data` under a root-only directory. This is a local rollback copy, not an off-node disaster recovery backup. Pre-upgrade application table counts were recorded locally in `/tmp/coop-clickhouse-preupgrade-counts.jsonl` and the StatefulSet in `/tmp/coop-clickhouse-before-upgrade.json`.

For rollback across this version gap, stop writers and ClickHouse and restore the cold copy with the old image. Do not assume a binary-only downgrade can read data modified by a newer release. Restoring the copy discards ClickHouse writes since the backup, so preserve the current volume separately and plan reconciliation before a restore.

Upstream guidance: https://clickhouse.com/docs/guides/oss/update

The cold copy completed successfully (3.7 GiB on disk). The live upgrade started with zero container restarts. All five populated application tables retained their pre-upgrade row counts: `CONTENT_API_REQUESTS` 151,325; `RULE_EXECUTIONS` 118,263; `MIGRATIONS_METADATA` 3; `ACTION_EXECUTIONS` 1; `ALL_ORGS` 1. The new server recognized `CGroupMemoryTotal = 3221225472` and reported `max_server_memory_usage = 2781123379`, with resident memory about 900 MiB before workers resumed. The new upstream defaults enable `async_insert` and `wait_for_async_insert`; inserts still wait for the flush acknowledgement. The copy took approximately 18 minutes because of the large number of small files, so queued submissions accumulated during the maintenance pause.

KEDA was unpaused and restored two workers. A 45.5-second sample with both workers active processed approximately 21.5 jobs/sec against 49.6 incoming/sec: waiting jobs increased from 151,174 to 152,453, and failed jobs remained 102. ClickHouse stayed near 1.2 GiB with no restarts through the first five minutes. The memory-detection fix is verified, but this does not solve full-feed processing capacity; the backlog still grows. Investigate insert/flush latency and upstream batching before increasing the worker cap or changing database defaults.
