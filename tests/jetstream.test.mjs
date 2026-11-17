import test from "node:test";
import assert from "node:assert/strict";
import * as feeder from "../files/jetstream.mjs";

const did = "did:plc:example";
const cid = "bafkreigh2akiscaildc7z4u5t6r7a5b6c";
function event(record = {}, operation = "create") {
  return {
    did,
    kind: "commit",
    time_us: 1,
    commit: {
      operation,
      collection: "app.bsky.feed.post",
      rkey: "post1",
      record: { text: "hello", createdAt: "2026-11-02T10:00:00Z", ...record },
    },
  };
}
const convert = (e) => feeder.toItem(e, "posts", "legacy");
const blob = { ref: { $link: cid } };

test("converts legacy and v2 post creates with stable IDs", () => {
  const item = convert(event());
  assert.equal(item.id, "at://did:plc:example/app.bsky.feed.post/post1");
  assert.equal(item.data.text, "hello");
  assert.equal(item.typeId, "posts");
  assert.deepEqual(
    feeder.toItem({ payload: { ...event().commit, did } }, "posts", "v2"),
    item,
  );
  assert.equal(convert(event({}, "delete")), null);
  assert.equal(convert(event({}, "update")), null);
  assert.equal(convert(null), null);
});

test("keeps media-only posts and aligned image alt text", () => {
  const item = convert(
    event({
      text: "",
      embed: {
        $type: "app.bsky.embed.images",
        images: [{ image: blob, alt: "first" }, { image: blob }],
      },
    }),
  );
  assert.deepEqual(item.data.mediaUrls, [
    `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`,
    `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`,
  ]);
  assert.deepEqual(item.data.mediaAltTexts, ["first", ""]);
  assert.deepEqual(item.data.mediaTypes, ["image", "image"]);
  assert.equal(item.data.text, "");
});

test("extracts video from recordWithMedia and link cards", () => {
  const item = convert(
    event({
      embed: {
        $type: "app.bsky.embed.recordWithMedia",
        media: {
          $type: "app.bsky.embed.video",
          video: blob,
          alt: "video description",
        },
        record: { record: { uri: "at://someone/quoted/post" } },
      },
    }),
  );
  assert.deepEqual(item.data.mediaUrls, [
    `https://video.bsky.app/watch/did%3Aplc%3Aexample/${cid}/playlist.m3u8`,
  ]);
  assert.deepEqual(item.data.mediaAltTexts, ["video description"]);
  assert.deepEqual(item.data.mediaTypes, ["video"]);
  const card = convert(
    event({
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: "https://example.org/article" },
      },
    }),
  );
  assert.equal(card.data.externalUrl, "https://example.org/article");
  assert.deepEqual(card.data.mediaUrls, []);
});

test("rejects malformed posts and ignores malformed media URLs", () => {
  assert.throws(() => convert(event({ createdAt: "bad" })), /Invalid/);
  assert.throws(() => convert(event({ text: 123 })), /Invalid/);
  const item = convert(
    event({
      embed: {
        $type: "app.bsky.embed.images",
        images: [
          { image: { ref: { $link: "../oops" } }, alt: "bad" },
          { image: blob, alt: "good" },
        ],
      },
    }),
  );
  assert.deepEqual(item.data.mediaAltTexts, ["good"]);
  const card = convert(
    event({
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: "javascript:alert(1)" },
      },
    }),
  );
  assert.equal(card.data.externalUrl, undefined);
});

function setup(options = {}) {
  const calls = [];
  let time = 100000;
  const forwarder = feeder.createForwarder({
    coopUrl: "http://coop",
    apiKey: "test",
    batchSize: 2,
    maxBufferItems: 3,
    maxBufferBytes: 10000,
    maxBatchBytes: 5000,
    now: () => time,
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(null, { status: 202 });
    },
    ...options,
  });
  return {
    forwarder,
    calls,
    advance: () => {
      time += 400000;
    },
  };
}
const item = (id) => ({ id, typeId: "posts", data: { text: "hello" } });

test("batches every post without sampling and bounds overflow", async () => {
  const { forwarder: f, calls } = setup();
  for (let i = 0; i < 4; i++) f.enqueue(item(String(i)));
  assert.equal(f.stats.droppedOverflow, 1);
  await f.flush();
  await f.flush();
  assert.deepEqual(
    calls.map((x) => x.items.map((i) => i.id)),
    [["0", "1"], ["2"]],
  );
  assert.equal(f.stats.accepted, 3);
  assert.equal(f.bufferedItems, 0);
});

test("bounds payload bytes and splits batches by bytes", async () => {
  const { forwarder: f, calls } = setup({
    maxBufferBytes: 400,
    maxBatchBytes: 200,
  });
  f.enqueue({ ...item("1"), data: { text: "x".repeat(80) } });
  f.enqueue({ ...item("2"), data: { text: "x".repeat(80) } });
  f.enqueue({ ...item("big"), data: { text: "x".repeat(500) } });
  await f.flush();
  await f.flush();
  assert.equal(calls.length, 2);
  assert.ok(calls.every((x) => Buffer.byteLength(JSON.stringify(x)) <= 200));
  assert.equal(f.stats.droppedOversize, 1);
});

test("in-flight batch counts toward the buffer limit and cannot be sent twice", async () => {
  let finish;
  const { forwarder: f } = setup({
    maxBufferItems: 2,
    fetchImpl: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  f.enqueue(item("1"));
  f.enqueue(item("2"));
  const pending = f.flush();
  await f.flush();
  f.enqueue(item("3"));
  assert.equal(f.stats.droppedOverflow, 1);
  finish(new Response(null, { status: 202 }));
  await pending;
  assert.equal(f.stats.accepted, 2);
});

test("drops failed batches, backs off, and resumes with later posts", async () => {
  let attempts = 0;
  const { forwarder: f, advance } = setup({
    fetchImpl: async () => {
      attempts++;
      return new Response(null, { status: attempts === 1 ? 503 : 202 });
    },
  });
  f.enqueue(item("1"));
  await f.flush();
  assert.equal(f.stats.droppedFailure, 1);
  f.enqueue(item("2"));
  await f.flush();
  assert.equal(attempts, 1);
  advance();
  await f.flush();
  assert.equal(f.stats.accepted, 1);
});

test("auth failure pauses submissions and shutdown accounts for buffered losses", async () => {
  const { forwarder: f } = setup({
    fetchImpl: async () => new Response(null, { status: 401 }),
  });
  f.enqueue(item("1"));
  f.enqueue(item("2"));
  f.enqueue(item("3"));
  await f.flush();
  f.enqueue(item("4"));
  assert.equal(f.blocked, true);
  assert.equal(f.bufferedItems, 0);
  assert.equal(f.stats.droppedFailure, 2);
  assert.equal(f.stats.droppedBlocked, 2);
  const { forwarder: g } = setup();
  g.enqueue(item("1"));
  g.stop();
  assert.equal(g.stats.droppedShutdown, 1);
});

test("byte budget includes in-flight payloads and releases them after network errors", async () => {
  let fail;
  const { forwarder: f } = setup({
    maxBufferItems: 100,
    maxBufferBytes: 100,
    fetchImpl: () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  });
  f.enqueue(item("1"));
  const pending = f.flush();
  f.enqueue(item("2"));
  assert.equal(f.stats.droppedOverflow, 1);
  fail(new Error("connection reset"));
  await pending;
  assert.equal(f.stats.droppedFailure, 1);
  assert.equal(f.bufferedBytes, 0);
  f.enqueue(item("3"));
  assert.equal(f.bufferedItems, 1);
});

test("honors Retry-After for later posts without replaying the failed batch", async () => {
  let now = 100000,
    attempts = 0;
  const sent = [];
  const { forwarder: f } = setup({
    now: () => now,
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body).items.map((x) => x.id));
      attempts++;
      return new Response(null, {
        status: attempts === 1 ? 429 : 202,
        headers: { "retry-after": "600" },
      });
    },
  });
  f.enqueue(item("1"));
  await f.flush();
  f.enqueue(item("2"));
  now += 400000;
  await f.flush();
  assert.equal(attempts, 1);
  now += 202000;
  await f.flush();
  assert.deepEqual(sent, [["1"], ["2"]]);
});

test("keeps in-flight accounting correct when stopped during a request", async () => {
  let finish;
  const { forwarder: f } = setup({
    fetchImpl: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  f.enqueue(item("1"));
  const pending = f.flush();
  f.enqueue(item("2"));
  f.stop();
  assert.equal(f.stats.droppedShutdown, 1);
  assert.equal(f.bufferedItems, 1);
  finish(new Response(null, { status: 202 }));
  await pending;
  assert.equal(f.stats.accepted, 1);
  assert.equal(f.bufferedItems, 0);
  assert.equal(f.bufferedBytes, 0);
});

for (const useSymlink of [false, true]) {
  test(
    `process reports final acceptance after shutdown (symlink=${useSymlink})`,
    { timeout: 10000 },
    async () => {
      const { createServer } = await import("node:http");
      const { spawn } = await import("node:child_process");
      const { once } = await import("node:events");
      let received;
      const request = new Promise((resolve) => {
        received = resolve;
      });
      const server = createServer((req, res) => {
        req.resume();
        received(res);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { resolve, join } = await import("node:path");
      const directory = mkdtempSync(join(tmpdir(), "coop-feeder-entry-"));
      const entry = useSymlink
        ? join(directory, "jetstream.mjs")
        : "files/jetstream.mjs";
      if (useSymlink) symlinkSync(resolve("files/jetstream.mjs"), entry);
      const child = spawn(
        process.execPath,
        ["--import", "./tests/fixtures/jetstream-preload.mjs", entry],
        {
          env: {
            ...process.env,
            JETSTREAM_URL: "wss://test.example/subscribe",
            JETSTREAM_FORMAT: "legacy",
            ITEM_TYPE_ID: "posts",
            COOP_API_KEY: "test",
            COOP_URL: `http://127.0.0.1:${server.address().port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = once(child, "exit");
      let output = "";
      let stopping;
      const stoppedStarting = new Promise((resolve) => {
        stopping = resolve;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes('"event":"stopping"')) stopping();
      });
      try {
        const res = await Promise.race([
          request,
          exited.then(() => {
            throw new Error("feeder exited before submitting");
          }),
        ]);
        child.kill("SIGTERM");
        await stoppedStarting;
        res.writeHead(202).end();
        await exited;
        const logs = output.trim().split("\n").map(JSON.parse);
        assert.equal(logs.find((x) => x.event === "stopped")?.accepted, 1);
      } finally {
        child.kill("SIGKILL");
        server.closeAllConnections();
        server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

test("omits link-card URLs rejected by Coop while retaining the post", () => {
  for (const uri of [
    "http://localhost/article",
    "http://127.0.0.1/article",
    "http://127.1/article",
  ]) {
    const result = convert(
      event({ embed: { $type: "app.bsky.embed.external", external: { uri } } }),
    );
    assert.equal(result.data.text, "hello");
    assert.equal(result.data.externalUrl, undefined);
  }
});
