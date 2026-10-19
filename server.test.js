/* global fetch, Response, DOMException, TextDecoder */
import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { URL } from "node:url";
import { createServer, isPublicAddress } from "./server.js";

const servers = new Set();

test("public address filtering rejects special, private, and IPv4-mapped IPv6 ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.10.2",
    "192.0.2.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      servers.delete(server);
    }),
  );
});

function responseJSON(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function searchHTML(number) {
  return `<a rel="nofollow" class="result__a" href="https://example.com/brand-${number}">Example Brand ${number}</a><div><a class="result__snippet">A search result for this name.</a></div>`;
}

function mockFetch({
  decisions = [],
  decisionStatus = 200,
  searchPages = [],
  pageResponses = {},
  classificationFailures = [],
} = {}) {
  const calls = {
    searches: [],
    summaries: 0,
    decisions: 0,
    decisionEvidenceCounts: [],
    pageVerdicts: [],
    decisionSignals: [],
    pageRequests: [],
    ollamaRequests: [],
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === "html.duckduckgo.com") {
      calls.searches.push(url.searchParams.get("q"));
      return new Response(searchPages[calls.searches.length - 1] || searchHTML(calls.searches.length), { status: 200 });
    }
    if (url.hostname === "api.openai.com") {
      calls.summaries += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-6-luna");
      return responseJSON({
        output: [
          {
            content: [{ type: "output_text", text: `Summary ${calls.summaries}` }],
          },
        ],
      });
    }
    if (["ollama.test", "nimble.example"].includes(url.hostname)) {
      calls.ollamaRequests.push(url.href);
      calls.decisions += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.model, "nimble");
      if (body.questions.trademark_exists) {
        calls.pageVerdicts.push({
          url: body.state.source_url,
          text: body.state.untrusted_page_text,
        });
        if (classificationFailures.includes(body.state.source_url)) {
          return responseJSON({ error: "Unavailable" }, 503);
        }
        return responseJSON({
          answers: {
            trademark_exists: {
              choice: calls.pageVerdicts.length % 2 ? "yes" : "no",
            },
          },
        });
      }
      assert.equal(body.questions.continue_search.type, "noul");
      assert.equal(body.state.max_searches, 10);
      calls.decisionEvidenceCounts.push(body.state.evidence.length);
      calls.decisionSignals.push(body.state.evidence.map(({ page_signal }) => page_signal));
      if (decisionStatus !== 200) {
        return responseJSON({ error: "Unavailable" }, decisionStatus);
      }
      const decision = decisions.length ? decisions.shift() : 0;
      return responseJSON({
        answers: { continue_search: { type: "noul", noul: decision } },
      });
    }
    if (url.hostname === "example.com") {
      calls.pageRequests.push({ url: url.href, headers: options.headers });
      const behavior = pageResponses[url.pathname];
      if (behavior === "loopback-redirect") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/admin" },
        });
      }
      if (behavior === "failure") {
        return new Response("failed", { status: 503 });
      }
      if (behavior === "large") {
        return new Response(`<html><body>${"relevant trademark evidence ".repeat(1_000)}</body></html>`, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response(`<html><body><h1>Trademark ${url.pathname}</h1><script>ignore me</script></body></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    throw new Error(`Unexpected upstream host: ${url.hostname}`);
  };
  return { fetchImpl, calls };
}

async function startServer(fetchImpl, options = {}) {
  const server = createServer({
    fetchImpl,
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    ollamaUrl: "http://ollama.test:11434",
    apiKey: "test-only-key",
    model: "gpt-6-luna",
    html: "<h1>Brand Oracle</h1>",
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function createJob(base, term) {
  const response = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ term }),
  });
  return { response, body: await response.json() };
}

function parseEvents(source) {
  return source
    .trim()
    .split("\n\n")
    .map((frame) => {
      const id = Number(frame.match(/^id: (\d+)$/m)?.[1]);
      const type = frame.match(/^event: (.+)$/m)?.[1];
      const data = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || "null");
      return { id, type, data };
    });
}

async function receiveJob(base, id, lastEventId) {
  const headers = lastEventId ? { "Last-Event-ID": String(lastEventId) } : {};
  const response = await fetch(`${base}/api/search/${id}/events`, { headers });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  return parseEvents(await response.text());
}

test("validates the search request before making upstream calls", async () => {
  const mock = mockFetch();
  const { base } = await startServer(mock.fetchImpl);
  const { response, body } = await createJob(base, "x");
  assert.equal(response.status, 400);
  assert.equal(body.error, "Enter at least two characters.");
  assert.equal(mock.calls.searches.length, 0);
});

test("uses the configured Ollama base URL for classification and search decisions", async () => {
  const mock = mockFetch({ decisions: [0.2] });
  const { base } = await startServer(mock.fetchImpl, {
    ollamaUrl: "https://nimble.example:11434/",
  });
  const { body } = await createJob(base, "Configured Host");
  await receiveJob(base, body.id);

  assert.equal(mock.calls.ollamaRequests.length, 2);
  assert.ok(mock.calls.ollamaRequests.every((url) => url === "https://nimble.example:11434/v1/systemone"));
});

test("private URLs, redirects, and per-page failures yield unknown while remaining pages still classify", async () => {
  const pageList =
    ["redirect", "failed", "good"]
      .map(
        (path) =>
          `<a rel="nofollow" class="result__a" href="https://example.com/${path}">${path}</a><a class="result__snippet">snippet</a>`,
      )
      .join("") +
    '<a rel="nofollow" class="result__a" href="http://127.0.0.1/admin">Private host</a><a class="result__snippet">snippet</a>';
  const mock = mockFetch({
    decisions: [0.2],
    searchPages: [pageList],
    pageResponses: { "/redirect": "loopback-redirect", "/failed": "failure" },
    classificationFailures: ["https://example.com/good"],
  });
  const { base } = await startServer(mock.fetchImpl);
  const { body } = await createJob(base, "Independent");
  const events = await receiveJob(base, body.id);
  assert.equal(events.find(({ type }) => type === "initial").data.turn, 1);
  assert.equal(mock.calls.pageVerdicts.length, 1);
  assert.equal(mock.calls.pageVerdicts[0].url, "https://example.com/good");
  assert.deepEqual(
    mock.calls.pageRequests.map(({ url }) => url),
    ["https://example.com/redirect", "https://example.com/failed", "https://example.com/good"],
  );
  assert.deepEqual(mock.calls.decisionSignals.at(-1), [
    {
      url: "https://example.com/redirect",
      verdict: "unknown",
      reason: "page_evidence_unavailable",
    },
    {
      url: "https://example.com/failed",
      verdict: "unknown",
      reason: "page_evidence_unavailable",
    },
    {
      url: "https://example.com/good",
      verdict: "unknown",
      reason: "classification_unavailable",
    },
    {
      url: "http://127.0.0.1/admin",
      verdict: "unknown",
      reason: "page_evidence_unavailable",
    },
  ]);
});

test("classifies multiple fetched pages independently and supplies URL-associated signals to continuation", async () => {
  const twoResults = `<a rel="nofollow" class="result__a" href="https://example.com/brand-1">One</a><a class="result__snippet">snippet one</a><a rel="nofollow" class="result__a" href="https://example.com/brand-2">Two</a><a class="result__snippet">snippet two</a>`;
  const mock = mockFetch({
    decisions: [0.2],
    searchPages: [twoResults],
    pageResponses: { "/brand-1": "large" },
  });
  const { base } = await startServer(mock.fetchImpl);
  const { response, body } = await createJob(base, "Chiria");
  assert.equal(response.status, 202);
  assert.match(body.id, /^[\da-f-]{36}$/);

  const events = await receiveJob(base, body.id);
  assert.deepEqual(
    events.map(({ type }) => type),
    ["progress", "evidence", "initial", "done"],
  );
  assert.equal(events[1].data.results.length, 2);
  assert.equal(events[2].data.summary, "Summary 1");
  assert.equal(events[3].data.turns, 1);
  assert.equal(mock.calls.searches.length, 1);
  assert.equal(mock.calls.summaries, 1);
  assert.equal(mock.calls.pageVerdicts.length, 2);
  assert.equal(mock.calls.pageVerdicts[0].url, "https://example.com/brand-1");
  assert.equal(mock.calls.pageVerdicts[1].url, "https://example.com/brand-2");
  assert.deepEqual(
    mock.calls.pageRequests.map(({ url }) => url),
    ["https://example.com/brand-1", "https://example.com/brand-2"],
  );
  assert.ok(mock.calls.pageRequests.every(({ headers }) => !headers?.Authorization && !headers?.Cookie));
  assert.match(mock.calls.pageVerdicts[0].text, /trademark/i);
  assert.ok(mock.calls.pageVerdicts[0].text.length <= 6_100);
  assert.doesNotMatch(mock.calls.pageVerdicts[0].text, /ignore me/);
  assert.equal(mock.calls.decisions, 3);
  assert.deepEqual(mock.calls.decisionSignals.at(-1), [
    { url: "https://example.com/brand-1", verdict: "yes" },
    { url: "https://example.com/brand-2", verdict: "no" },
  ]);

  const replayed = await receiveJob(base, body.id, events[0].id);
  assert.deepEqual(
    replayed.map(({ type }) => type),
    ["evidence", "initial", "done"],
  );
});

test("continues incrementally but never exceeds ten search turns", async () => {
  const mock = mockFetch({ decisions: Array(20).fill(1) });
  const { base } = await startServer(mock.fetchImpl);
  const { body } = await createJob(base, "Northstar");
  const events = await receiveJob(base, body.id);
  const initial = events.filter(({ type }) => type === "initial");
  const updates = events.filter(({ type }) => type === "update");
  const done = events.find(({ type }) => type === "done");

  assert.equal(initial.length, 1);
  assert.equal(updates.length, 9);
  assert.equal(done.data.turns, 10);
  assert.equal(done.data.reason, "turn_limit");
  assert.equal(mock.calls.searches.length, 10);
  assert.equal(mock.calls.summaries, 10);
  assert.equal(mock.calls.decisions, 10);
  assert.ok(mock.calls.decisionEvidenceCounts.every((count) => count <= 8));
  assert.ok(mock.calls.searches.some((query) => query.includes("tmsearch.uspto.gov")));
  assert.ok(mock.calls.searches.some((query) => query.includes("branddb.wipo.int")));
  assert.equal(events.at(-1).id, 40);
});

test("stops safely when Nimble is unavailable after sending the initial result", async () => {
  const mock = mockFetch({ decisionStatus: 503 });
  const { base } = await startServer(mock.fetchImpl);
  const { body } = await createJob(base, "Sample Name");
  const events = await receiveJob(base, body.id);
  const done = events.find(({ type }) => type === "done");

  assert.ok(events.some(({ type }) => type === "initial"));
  assert.equal(events.filter(({ type }) => type === "update").length, 0);
  assert.equal(done.data.reason, "decision_service_unavailable");
  assert.match(done.data.status, /local decision service/);
  assert.equal(mock.calls.searches.length, 1);
});

test("pauses after registered-name evidence until the user expands the search", async () => {
  const registeredResult =
    '<a rel="nofollow" class="result__a" href="https://example.test/fugu">FUGU Trademark</a><div><a class="result__snippet">FUGU is a registered trademark, registration number 123.</a></div>';
  const mock = mockFetch({
    searchPages: [registeredResult, searchHTML(2)],
    decisions: [0.2],
  });
  const { base } = await startServer(mock.fetchImpl);
  const { body } = await createJob(base, "FUGU");
  const stream = await fetch(`${base}/api/search/${body.id}/events`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let events = [];
  while (!events.some(({ type }) => type === "initial")) {
    const { done, value } = await reader.read();
    assert.equal(done, false);
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split("\n\n");
    buffered = frames.pop();
    events.push(...frames.filter(Boolean).flatMap((frame) => parseEvents(frame)));
  }
  const initial = events.find(({ type }) => type === "initial");
  assert.equal(initial.data.hasRegisteredMatches, true);
  assert.equal(mock.calls.searches.length, 1);

  const expanded = await fetch(`${base}/api/search/${body.id}/expand`, {
    method: "POST",
  });
  assert.equal(expanded.status, 202);
  while (!events.some(({ type }) => type === "done")) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split("\n\n");
    buffered = frames.pop();
    events.push(...frames.filter(Boolean).flatMap((frame) => parseEvents(frame)));
  }
  assert.equal(mock.calls.searches.length, 2);
  assert.equal(events.at(-1).type, "done");
});

test("cancels an in-progress search and closes the EventSource stream", async () => {
  let notifySearchStarted;
  const searchStarted = new Promise((resolve) => {
    notifySearchStarted = resolve;
  });
  const fetchImpl = async (input, options = {}) => {
    if (new URL(input).hostname === "html.duckduckgo.com") {
      notifySearchStarted();
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    }
    throw new Error("The cancelled search must not contact further providers");
  };
  const { base } = await startServer(fetchImpl);
  const { body } = await createJob(base, "Slow Search");
  await searchStarted;
  const streamResponse = await fetch(`${base}/api/search/${body.id}/events`);
  const cancelResponse = await fetch(`${base}/api/search/${body.id}`, {
    method: "DELETE",
  });
  const events = parseEvents(await streamResponse.text());

  assert.equal(cancelResponse.status, 204);
  assert.deepEqual(
    events.map(({ type }) => type),
    ["progress", "done"],
  );
  assert.equal(events[1].data.reason, "cancelled");
});
