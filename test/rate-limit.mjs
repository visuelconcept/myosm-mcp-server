/**
 * Nominatim politeness test: spacing between requests, retry on 429, and the
 * geocoding cache. `fetch` is stubbed, so nothing here touches the network.
 *
 * Usage:
 *   npm run build && node test/rate-limit.mjs
 */
import { OSMClient } from "../dist/osm-client.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${message}`);
  }
}

const realFetch = globalThis.fetch;

/** Replace fetch with a recorder; `plan` maps a call index to its response. */
function stubFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const index = calls.length;
    calls.push({ url: String(url), at: Date.now() });
    const status = plan(index);
    if (status === 200) {
      return new Response(JSON.stringify([{ lat: "47.0", lon: "2.0" }]), { status: 200 });
    }
    return new Response("", {
      status,
      statusText: "Too Many Requests",
      headers: { "retry-after": "0" },
    });
  };
  return calls;
}

// ---- spacing --------------------------------------------------------------
{
  const calls = stubFetch(() => 200);
  const client = new OSMClient({ nominatimMinIntervalMs: 120, geocodeCacheTtlMs: 0 });
  const started = Date.now();
  await Promise.all([
    client.geocode("Belleville-sur-Loire"),
    client.geocode("Saint-Laurent"),
    client.geocode("Dampierre"),
  ]);
  const elapsed = Date.now() - started;
  assert(calls.length === 3, "three concurrent lookups issue three requests");
  assert(elapsed >= 240, `concurrent lookups are spaced out (${elapsed}ms for 3)`);
  const gaps = calls.slice(1).map((call, i) => call.at - calls[i].at);
  assert(
    gaps.every((gap) => gap >= 110),
    `every gap respects the interval (${gaps.join("ms, ")}ms)`,
  );
}

// ---- retry on 429 ---------------------------------------------------------
{
  const calls = stubFetch((index) => (index < 2 ? 429 : 200));
  const client = new OSMClient({ nominatimMinIntervalMs: 0, geocodeCacheTtlMs: 0 });
  const result = await client.geocode("Belleville-sur-Loire");
  assert(calls.length === 3, "a 429 is retried until it succeeds");
  assert(Array.isArray(result) && result.length === 1, "the retried call returns its payload");
}

// ---- exhausted retries surface a clear error ------------------------------
{
  stubFetch(() => 429);
  const client = new OSMClient({
    nominatimMinIntervalMs: 0,
    geocodeCacheTtlMs: 0,
    maxRetries: 1,
  });
  let message = "";
  try {
    await client.geocode("Belleville-sur-Loire");
  } catch (error) {
    message = error.message;
  }
  assert(message.includes("429"), "the error keeps the status");
  assert(message.includes("after 1 retry"), `the error says it retried — got: ${message}`);
}

// ---- cache ----------------------------------------------------------------
{
  const calls = stubFetch(() => 200);
  const client = new OSMClient({ nominatimMinIntervalMs: 0 });
  await Promise.all([client.geocode("Belleville-sur-Loire"), client.geocode("Belleville-sur-Loire")]);
  await client.geocode("Belleville-sur-Loire");
  assert(calls.length === 1, "identical lookups (concurrent and later) share one request");
  await client.geocode("Belleville-sur-Loire", 1);
  assert(calls.length === 2, "a different limit is a different cache key");
}

// ---- a failure is not cached ----------------------------------------------
{
  const calls = stubFetch((index) => (index === 0 ? 429 : 200));
  const client = new OSMClient({ nominatimMinIntervalMs: 0, maxRetries: 0 });
  await client.geocode("Dampierre").catch(() => undefined);
  await client.geocode("Dampierre");
  assert(calls.length === 2, "a failed lookup is not remembered");
}

globalThis.fetch = realFetch;
console.log(process.exitCode ? "rate-limit test FAILED" : "rate-limit test passed");
