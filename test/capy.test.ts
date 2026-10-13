import { expect, test } from "bun:test";
import { CapyError, createCapyClient, type Fetch } from "../src/capy/client";
import { waitForRunEnd } from "../src/capy/watch";

const sse = (text: string) => new Response(text, { headers: { "Content-Type": "text/event-stream" } });
const noop = async () => {};

test("creates a thread with the documented fields and pages through its transcript", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fake: Fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === "POST") return Response.json({ id: "t", status: "working" });
    if (url.endsWith("/messages")) return Response.json({ items: [{ id: "1", source: "assistant", text: "first", createdAt: "now" }], cursor: "cursor-1", beforeCursor: null });
    return Response.json({ items: [{ id: "2", source: "assistant", text: "last", createdAt: "now" }], cursor: null, beforeCursor: "cursor-1" });
  };
  const client = createCapyClient("secret", "https://example.test/api/v1", fake);
  expect((await client.createThread({ requestId: "interaction", projectId: "project", message: "task", title: "task" })).id).toBe("t");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ requestId: "interaction", projectId: "project", message: "task", title: "task", pullRequestAuthor: "capy" });
  expect(requests[0]?.url).toBe("https://example.test/api/v1/threads");
  expect((await client.getTranscript("t")).map((item) => item.text)).toEqual(["first", "last"]);
  expect(requests[2]?.url).toContain("?after=cursor-1");
});

test("a clean done ends the watcher", async () => {
  const fake: Fetch = async () => sse("event: heartbeat\ndata: {}\n\nevent: done\ndata: {}\n\n");
  expect(await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", noop)).toBe("done");
});

test("a dropped stream resumes after the last transcript ID", async () => {
  const urls: string[] = [];
  const fake: Fetch = async (input) => {
    urls.push(String(input));
    return urls.length === 1 ? sse("event: transcript\nid: cursor-2\ndata: {}\n\n") : sse("event: done\ndata: {}\n\n");
  };
  expect(await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", noop)).toBe("done");
  expect(urls[1]).toContain("after=cursor-2");
});

test("a stream error reconnects without reading untyped payload fields", async () => {
  let calls = 0;
  const fake: Fetch = async () => ++calls === 1 ? sse("event: error\ndata: {\"unknown\":true}\n\n") : sse("event: done\ndata: {}\n\n");
  expect(await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", noop)).toBe("done");
  expect(calls).toBe(2);
});

test("progress across several disconnected streams does not exhaust reconnects", async () => {
  let calls = 0;
  const fake: Fetch = async () => {
    calls++;
    return calls <= 6 ? sse(`event: transcript\nid: cursor-${calls}\ndata: {}\n\n`) : sse("event: done\ndata: {}\n\n");
  };
  expect(await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", noop)).toBe("done");
  expect(calls).toBe(7);
});

test("five empty streams without progress return lost", async () => {
  let calls = 0;
  const fake: Fetch = async () => { calls++; return sse(""); };
  expect(await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", noop)).toBe("lost");
  expect(calls).toBe(5);
});

test("a rate limit waits for retryAfterSeconds before reconnecting", async () => {
  const delays: number[] = [];
  let calls = 0;
  const fake: Fetch = async () => ++calls === 1 ? Response.json({ _tag: "capy/RateLimited", retryAfterSeconds: 7 }, { status: 429 }) : sse("event: done\ndata: {}\n\n");
  expect(await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", async (ms) => { delays.push(ms); })).toBe("done");
  expect(delays).toEqual([7000]);
});

test("tagged errors retain their tag and status", async () => {
  const fake: Fetch = async () => Response.json({ _tag: "capy/Forbidden" }, { status: 403 });
  try {
    await createCapyClient("key", "https://example.test/api/v1", fake).getThread("t");
    throw new Error("Expected a tagged error");
  } catch (error) {
    expect(error).toBeInstanceOf(CapyError);
    expect(error).toMatchObject({ tag: "capy/Forbidden", status: 403 });
  }
});

test("five failed reconnects return lost", async () => {
  let calls = 0;
  const fake: Fetch = async () => { calls++; throw new Error("offline"); };
  expect(await waitForRunEnd(createCapyClient("key", "https://example.test/api/v1", fake), "t", noop)).toBe("lost");
  expect(calls).toBe(5);
});
