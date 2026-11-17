import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// No lookups or media downloads: attachment URLs are derived from the record.
export function toItem(event, typeId, format) {
  const post =
    format === "v2"
      ? event?.payload
      : event?.kind === "commit"
        ? { ...event.commit, did: event.did }
        : null;
  if (post?.operation !== "create" || post.collection !== "app.bsky.feed.post")
    return null;
  const record = post.record;
  if (
    typeof post.did !== "string" ||
    !/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/.test(post.did) ||
    typeof post.rkey !== "string" ||
    !/^[a-zA-Z0-9._~-]{1,512}$/.test(post.rkey) ||
    typeof record?.text !== "string" ||
    record.text.length > 10000 ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error("Invalid post");
  }
  const data = {
    text: record.text,
    authorDid: post.did,
    createdAt: new Date(record.createdAt).toISOString(),
    sourceUrl: `https://bsky.app/profile/${post.did}/post/${post.rkey}`,
    languages: Array.isArray(record.langs)
      ? record.langs
          .filter((x) => typeof x === "string")
          .join(", ")
          .slice(0, 256)
      : "",
    mediaUrls: [],
    mediaAltTexts: [],
    mediaTypes: [],
  };
  const embed =
    record.embed?.$type === "app.bsky.embed.recordWithMedia"
      ? record.embed.media
      : record.embed;
  const addMedia = (blob, alt, kind) => {
    const cid = blob?.ref?.$link ?? blob?.cid;
    if (
      typeof cid !== "string" ||
      !/^(b[a-z2-7]{10,199}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(cid)
    )
      return;
    const url =
      kind === "image"
        ? `https://cdn.bsky.app/img/feed_fullsize/plain/${post.did}/${cid}@jpeg`
        : `https://video.bsky.app/watch/${encodeURIComponent(post.did)}/${cid}/playlist.m3u8`;
    data.mediaUrls.push(url);
    data.mediaAltTexts.push(typeof alt === "string" ? alt.slice(0, 10000) : "");
    data.mediaTypes.push(kind);
  };
  if (embed?.$type === "app.bsky.embed.images" && Array.isArray(embed.images)) {
    for (const image of embed.images.slice(0, 4))
      addMedia(image?.image, image?.alt, "image");
  } else if (embed?.$type === "app.bsky.embed.video") {
    addMedia(embed.video, embed.alt, "video");
  } else if (embed?.$type === "app.bsky.embed.external") {
    try {
      const url = new URL(embed.external?.uri);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        // Match Coop's URL validation with ALLOW_USER_INPUT_LOCALHOST_URIS=false.
        !["localhost", "127.0.0.1"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        url.href.length <= 8192
      )
        data.externalUrl = url.href;
    } catch {
      /* A malformed card must not discard the post. */
    }
  }
  return {
    id: `at://${post.did}/app.bsky.feed.post/${post.rkey}`,
    typeId,
    data,
  };
}

// Limits include the in-flight batch. No disk storage, retries, or replay.
export function createForwarder({
  coopUrl,
  apiKey,
  batchSize,
  maxBufferItems,
  maxBufferBytes,
  maxBatchBytes,
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
}) {
  const queue = [];
  let bytes = 0,
    inFlight = 0,
    nextAttempt = 0,
    failures = 0,
    stopped = false,
    blocked = false,
    lastAccepted = 0;
  const stats = {
    accepted: 0,
    failedBatches: 0,
    droppedOverflow: 0,
    droppedOversize: 0,
    droppedFailure: 0,
    droppedBlocked: 0,
    droppedShutdown: 0,
  };
  const discardQueue = (counter) => {
    stats[counter] += queue.length;
    for (const entry of queue) bytes -= entry.bytes;
    queue.length = 0;
  };
  return {
    stats,
    get blocked() {
      return blocked;
    },
    get lastAccepted() {
      return lastAccepted;
    },
    get bufferedItems() {
      return queue.length + inFlight;
    },
    get bufferedBytes() {
      return bytes;
    },
    enqueue(item) {
      if (stopped || blocked) {
        stats[stopped ? "droppedShutdown" : "droppedBlocked"]++;
        return;
      }
      const json = JSON.stringify(item);
      const size = Buffer.byteLength(json) + 1; // includes the array separator
      if (size + 12 > maxBatchBytes) {
        stats.droppedOversize++;
        return;
      }
      if (
        queue.length + inFlight >= maxBufferItems ||
        bytes + size > maxBufferBytes
      ) {
        stats.droppedOverflow++;
        return;
      }
      queue.push({ json, bytes: size });
      bytes += size;
    },
    async flush() {
      if (
        stopped ||
        blocked ||
        inFlight ||
        !queue.length ||
        now() < nextAttempt
      )
        return;
      const batch = [];
      let batchBytes = 0;
      while (
        queue.length &&
        batch.length < batchSize &&
        batchBytes + queue[0].bytes + 12 <= maxBatchBytes
      ) {
        const entry = queue.shift();
        batch.push(entry);
        batchBytes += entry.bytes;
      }
      inFlight = batch.length;
      let status = "network",
        retryAfter = 0;
      try {
        const response = await fetchImpl(`${coopUrl}/api/v1/items/async/`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          body: `{"items":[${batch.map((x) => x.json).join(",")}]}`,
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        status = response.status;
        const header = response.headers.get("retry-after");
        if (header)
          retryAfter = Number.isFinite(Number(header))
            ? Number(header) * 1000
            : Date.parse(header) - now();
        // Do not turn an accepted request into a failure if body cancellation fails.
        await response.body?.cancel().catch(() => {});
      } catch {
        /* Ambiguous requests are not retried: Coop may have accepted them. */
      } finally {
        bytes -= batchBytes;
        inFlight = 0;
      }
      if (status === 202) {
        stats.accepted += batch.length;
        lastAccepted = now();
        failures = 0;
        return;
      }
      stats.failedBatches++;
      stats.droppedFailure += batch.length;
      if (status !== "network" && status !== 429 && status < 500) {
        blocked = true;
        discardQueue("droppedBlocked");
        log("configuration_error", { status });
        return;
      }
      failures++;
      const delay = Math.max(
        Math.min(300000, 1000 * 2 ** Math.min(failures, 8)),
        Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0,
      );
      nextAttempt = now() + delay + Math.random() * 1000;
      log("submission_failed", {
        status,
        dropped: batch.length,
        delaySeconds: Math.ceil(delay / 1000),
      });
    },
    stop() {
      stopped = true;
      discardQueue("droppedShutdown");
    },
  };
}

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

function main() {
  const endpoint = new URL(process.env.JETSTREAM_URL);
  const format = process.env.JETSTREAM_FORMAT ?? "legacy";
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username ||
    endpoint.password ||
    !["legacy", "v2"].includes(format)
  )
    throw new Error("Invalid Jetstream configuration");
  // Endpoint configuration cannot accidentally narrow coverage or request a backfill.
  endpoint.search = "";
  if (format === "legacy")
    endpoint.searchParams.set("wantedCollections", "app.bsky.feed.post");
  else {
    endpoint.searchParams.set("collections", "app.bsky.feed.post");
    endpoint.searchParams.set("kinds", "commit");
  }
  const typeId = process.env.ITEM_TYPE_ID,
    apiKey = process.env.COOP_API_KEY;
  const coop = new URL(process.env.COOP_URL);
  if (
    !typeId ||
    !apiKey ||
    !["http:", "https:"].includes(coop.protocol) ||
    coop.username ||
    coop.password
  )
    throw new Error("Invalid Coop configuration");
  const log = (event, fields = {}) =>
    console.log(
      JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
    );
  const forwarder = createForwarder({
    coopUrl: coop.href.replace(/\/$/, ""),
    apiKey,
    log,
    batchSize: integer("BATCH_SIZE", 100, 1, 500),
    maxBufferItems: integer("MAX_BUFFER_ITEMS", 1000, 1, 10000),
    maxBufferBytes: integer("MAX_BUFFER_BYTES", 8388608, 1024, 33554432),
    maxBatchBytes: integer("MAX_BATCH_BYTES", 524288, 1024, 1048576),
  });
  let socket,
    reconnectTimer,
    handshakeTimer,
    connected = false,
    stopping = false;
  let lastMessage = 0,
    disconnectStarted = Date.now();
  const stats = { received: 0, eligible: 0, invalid: 0, reconnects: 0 };
  const snapshot = () => ({
    connected,
    permanentFailure: forwarder.blocked,
    lastAccepted: forwarder.lastAccepted,
    bufferedItems: forwarder.bufferedItems,
    bufferedBytes: forwarder.bufferedBytes,
    ...stats,
    ...forwarder.stats,
  });
  function connect() {
    if (stopping) return;
    socket = new WebSocket(endpoint);
    handshakeTimer = setTimeout(() => socket.close(), 30000);
    socket.addEventListener("open", () => {
      clearTimeout(handshakeTimer);
      connected = true;
      disconnectStarted = 0;
      lastMessage = Date.now();
      log("connected", { host: endpoint.hostname, format });
    });
    socket.addEventListener("message", ({ data }) => {
      lastMessage = Date.now();
      stats.received++;
      if (typeof data !== "string" || Buffer.byteLength(data) > 131072) {
        stats.invalid++;
        return;
      }
      try {
        const item = toItem(JSON.parse(data), typeId, format);
        if (item) {
          stats.eligible++;
          forwarder.enqueue(item);
        }
      } catch {
        stats.invalid++;
      }
    });
    socket.addEventListener("error", () => {
      log("stream_error");
      socket.close();
    });
    socket.addEventListener("close", () => {
      clearTimeout(handshakeTimer);
      connected = false;
      disconnectStarted ||= Date.now();
      if (stopping) return;
      stats.reconnects++;
      reconnectTimer = setTimeout(connect, 5000 + Math.random() * 10000);
    });
  }
  const server = createServer((req, res) => {
    if (req.url !== "/healthz" && req.url !== "/readyz") {
      res.writeHead(404).end();
      return;
    }
    const ready =
      !stopping &&
      connected &&
      !forwarder.blocked &&
      Date.now() - lastMessage < 120000 &&
      Date.now() - forwarder.lastAccepted < 300000;
    res.writeHead((req.url === "/healthz" ? !stopping : ready) ? 200 : 503, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(snapshot()));
  });
  server.listen(8090, "0.0.0.0");
  let activeSubmission;
  const tick = setInterval(
    () => {
      if (connected && Date.now() - lastMessage > 120000) {
        disconnectStarted ||= Date.now();
        socket.close();
      }
      if (disconnectStarted && Date.now() - disconnectStarted > 60000) {
        shutdown(1, "stream_watchdog_restart");
        return;
      }
      if (!activeSubmission)
        activeSubmission = forwarder.flush().finally(() => {
          activeSubmission = undefined;
        });
    },
    integer("FLUSH_INTERVAL_MS", 250, 50, 5000),
  );
  const report = setInterval(() => log("stats", snapshot()), 60000);
  connect();
  function shutdown(exitCode, event = "stopping") {
    if (stopping) return;
    stopping = true;
    forwarder.stop();
    clearTimeout(reconnectTimer);
    clearTimeout(handshakeTimer);
    clearInterval(tick);
    clearInterval(report);
    socket?.close();
    server.close();
    log(event, snapshot());
    process.exitCode = exitCode;
    Promise.resolve(activeSubmission).finally(() => log("stopped", snapshot()));
    setTimeout(() => {
      log("shutdown_deadline", snapshot());
      process.exit(exitCode);
    }, 17000).unref();
  }
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => shutdown(0));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main();
