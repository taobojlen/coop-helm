# Worker throughput investigation — 2026-11-02

## Finding

Coop's ClickHouse analytics write path is a significant processing bottleneck. Both workers saturate their default ten-connection ClickHouse HTTP pools with small, awaited inserts. Cross-job batching is the most promising upstream change; increasing replicas or pool size alone adds pressure with less benefit. No production configuration or application code was changed during this investigation.

## Live evidence

- Two workers, native concurrency 30 each. A 45.108-second sample received 2,129 posts while the waiting list grew by 990, with 60 active jobs and no new failed jobs: approximately 25.3 completed jobs/sec versus 47.2 incoming/sec.
- Each post generates one `CONTENT_API_REQUESTS` row and two `RULE_EXECUTIONS` rows, sent as two separate insert requests. Query-log samples showed roughly 334 ms and 370 ms mean insert latency respectively (p95 approximately 779 ms and 842 ms).
- `system.processes` showed ten in-flight inserts from each worker IP. The deployed `@clickhouse/client` defaults `max_open_connections` to ten; the deployed Coop adapter does not override it.
- Twenty connections, two requests per post, and roughly 350 ms/request predict about 29 posts/sec before other overhead, consistent with the observed throughput. This is a capacity estimate, not a per-job trace measurement.
- Worker CPU was roughly 190–245 millicores each, ClickHouse around three cores, and node CPU around 62%. No delayed inserts were reported at the sampled instant. ClickHouse memory was approximately 1.5 GiB, with its container-limit detection fixed after the upgrade.
- ClickHouse's upstream defaults already enable server-side asynchronous batching and wait for the flush acknowledgement. Server flushes averaged about six content rows and thirteen rule rows, but the HTTP requests occupy the client's limited connection pool while waiting.

## Source confirmation

Checked the deployed JavaScript as well as local Coop source:

- `server/workers_jobs/ItemProcessingWorker.ts` awaits Scylla insertion, enabled rules, and content analytics logging; concurrency is hardcoded to 30.
- `server/storage/dataWarehouse/DataWarehouseFactory.ts` forwards `bulkWrite` to the analytics adapter.
- `server/plugins/analytics/adapters/ClickhouseAnalyticsAdapter.ts` inserts each call immediately. Its `defaultBatchSize: 500` partitions rows already supplied to one call; it does not combine concurrent calls. `writeEvents` ignores batching options, and `flush()` is a no-op.
- The deployed client sets `max_open_connections` to ten unless supplied explicitly.

## Small synthetic comparison

Executed from a diagnostic Node process in the API pod, with OTel preloading disabled. Created a uniquely named temporary analytics table using the production content-table schema, then inserted only synthetic 2 KiB text payloads. Each case wrote 240 rows with up to 30 concurrent callers. Production workers continued running, so these results include contention and are directional, not a controlled end-to-end benchmark.

| Rows per request | Client connections | Rows/sec | Median caller latency |
| --- | --- | --- | --- |
| 1 | 10 | 22.9 | 1,214 ms |
| 1 | 30 | 27.7 | 867 ms |
| 20 | 10 | 265.3 | 713 ms |
| 1 (repeat) | 10 | 17.8 | 1,501 ms |

Verified all 960 synthetic rows before dropping the table. Independently confirmed the table no longer exists. No real posts or moderation rules were modified. The test used default asynchronous insert/acknowledgement behavior and did not change server or user settings.

## Recommended next change

Implement batching of concurrent analytics writes in Coop's ClickHouse adapter, so all adopters benefit. Preserve acknowledgement/error behavior and flush pending writes on shutdown. Measure actual worker completion rate, failures, and latency after that upstream change. The synthetic result does not establish a 265-post/sec capacity for Coop, which also writes rule analytics and runs moderation logic.

Keep the current two-worker cap while addressing this. Increasing the pool could help somewhat, but this test did not establish that a pool-only change would meet the full feed's arrival rate. No existing native environment setting was found for cross-call batching or this client's pool size.
