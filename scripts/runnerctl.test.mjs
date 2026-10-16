import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { requestControl, discoveryPath } from "./runnerctl.mjs";

test("CLI sends authenticated structured requests and surfaces server errors", async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    if (request.action === "cancel") {
      res.writeHead(400).end(JSON.stringify({ error: "Run already ended" }));
    } else {
      res.end(JSON.stringify({ id: "graph-1", nodes: request.nodes }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const discovery = { url: `http://127.0.0.1:${server.address().port}/v1/control`, token: "test-token" };
  try {
    const nodes = [
      { id: "a", harness: "zcode", supervision: { commander: "opencode", max_rounds: 3 } },
      { id: "b", harness: "deck", supervision: { commander: "codex", max_rounds: 2 } },
    ];
    assert.deepEqual(await requestControl(discovery, { action: "submit", nodes }), { id: "graph-1", nodes });
    await assert.rejects(requestControl(discovery, { action: "cancel" }), /Run already ended/);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test("discovery override is explicit and credentials cannot be sent to a remote endpoint", async () => {
  assert.equal(discoveryPath({ AGENT_DECK_CONTROL_FILE: "custom/control.json" }), "custom/control.json");
  await assert.rejects(requestControl({ url: "http://example.com/v1/control", token: "secret" }, {}), /Invalid local/);
});
