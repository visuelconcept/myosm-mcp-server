/**
 * HTTP transport test: starts the server in Streamable HTTP mode against a
 * mock Nominatim, then checks the MCP handshake, session handling, a tool
 * call, the health endpoint and session termination.
 *
 * No external network access is required.
 *
 * Usage: npm run build && node test/http.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

// --- mock Nominatim ---------------------------------------------------------

const mock = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/search") {
    res.end(
      JSON.stringify([
        { lat: "48.8584", lon: "2.2945", display_name: "Tour Eiffel, Paris, France" },
      ]),
    );
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const nominatimBase = `http://127.0.0.1:${mock.address().port}`;

// --- start the server in HTTP mode -------------------------------------------

const child = spawn(process.execPath, ["dist/index.js", "--http", "--port", "0"], {
  env: { ...process.env, NOMINATIM_URL: nominatimBase },
  stdio: ["ignore", "ignore", "pipe"],
});

const serverUrl = await new Promise((resolve, reject) => {
  let stderr = "";
  const timeout = setTimeout(
    () => reject(new Error(`server did not start; stderr: ${stderr}`)),
    15000,
  );
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    const match = stderr.match(/listening on (http:\/\/[^\s]+\/mcp)/);
    if (match) {
      clearTimeout(timeout);
      resolve(match[1]);
    }
  });
  child.on("exit", (code) => reject(new Error(`server exited early (${code}): ${stderr}`)));
});
console.log(`server started at ${serverUrl}`);

try {
  // Health endpoint
  const health = await (await fetch(new URL("/health", serverUrl))).json();
  assert(health.status === "ok" && health.server === "myosm-mcp-server", "GET /health reports ok");

  // First MCP session over HTTP
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(transport);
  assert(typeof transport.sessionId === "string", "initialize opens a session (Mcp-Session-Id)");

  const { tools } = await client.listTools();
  assert(tools.length === 22, `tools/list over HTTP returns 22 tools (got ${tools.length})`);

  const result = await client.callTool({
    name: "geocode_address",
    arguments: { address: "Tour Eiffel" },
  });
  const data = JSON.parse(result.content.find((item) => item.type === "text").text);
  assert(
    !result.isError && data[0].coordinates.latitude === 48.8584,
    "tools/call works over HTTP",
  );

  // A second concurrent session gets its own session id
  const transport2 = new StreamableHTTPClientTransport(new URL(serverUrl));
  const client2 = new Client({ name: "http-test-2", version: "1.0.0" });
  await client2.connect(transport2);
  assert(
    typeof transport2.sessionId === "string" && transport2.sessionId !== transport.sessionId,
    "concurrent clients get distinct sessions",
  );

  const healthSessions = await (await fetch(new URL("/health", serverUrl))).json();
  assert(healthSessions.sessions === 2, `health reports 2 active sessions (got ${healthSessions.sessions})`);

  // DELETE terminates the session server-side
  await transport2.terminateSession();
  assert(transport2.sessionId === undefined, "DELETE /mcp terminates the session");
  await client2.close();

  // Requests without a valid session are rejected
  const bad = await fetch(new URL(serverUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "00000000-0000-0000-0000-000000000000",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  assert(bad.status === 404, `unknown session is rejected with 404 (got ${bad.status})`);

  await client.close();
} finally {
  child.kill();
  mock.close();
}

if (failures > 0) {
  console.error(`\nHTTP transport test FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nHTTP transport test passed");
