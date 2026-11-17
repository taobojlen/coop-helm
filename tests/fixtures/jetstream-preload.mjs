// Replace only the remote stream; run the actual process and HTTP transport.
globalThis.WebSocket = class extends EventTarget {
  constructor() {
    super();
    setImmediate(() => {
      this.dispatchEvent(new Event("open"));
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            did: "did:plc:example",
            kind: "commit",
            commit: {
              operation: "create",
              collection: "app.bsky.feed.post",
              rkey: "shutdown",
              record: { text: "test", createdAt: "2026-11-02T10:00:00Z" },
            },
          }),
        }),
      );
    });
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
};
