import { describe, expect, test } from "bun:test";
import { resultFor, threadLink } from "../src/result";
import type { Thread, TranscriptMessage } from "../src/capy/client";

const thread: Thread = { id: "thread-1", status: "idle" };
const assistant = (text: string): TranscriptMessage => ({ id: "m", source: "assistant", text, createdAt: "now" });

describe("resultFor", () => {
  test.each([
    ["one PR", thread, [assistant("https://github.com/a/b/pull/1")], "pr", "https://github.com/a/b/pull/1"],
    ["last PR", thread, [assistant("https://github.com/a/b/pull/1 then https://github.com/a/b/pull/2")], "pr", "https://github.com/a/b/pull/2"],
    ["no PR", thread, [assistant("Please clarify")], "needs_input", "Please clarify"],
    ["failed", { ...thread, status: "failed" } as Thread, [assistant("Oops")], "failed", "Run failed"],
    ["empty", thread, [], "needs_input", "No response yet."],
  ] as const)("%s", (_name, state, messages, kind, text) => {
    const result = resultFor(state, [...messages], "Capy thread thread-1");
    expect(result.kind).toBe(kind);
    expect(result.text).toContain(text);
  });

  test("lost overrides an unfinished result", () => {
    expect(resultFor(thread, [], "link", true).kind).toBe("lost");
  });
});

describe("links", () => {
  test("PR results use a short labelled link", () => {
    expect(resultFor(thread, [assistant("done: https://github.com/a/b/pull/12")], "link").text).toBe("✅ PR ready: [PR #12](https://github.com/a/b/pull/12)");
  });

  test("thread links are a labelled hyperlink without a preview card", () => {
    expect(threadLink("t-1", "https://capy.ai/thread/{id}")).toBe("[Open in Capy](<https://capy.ai/thread/t-1>)");
    expect(threadLink("t-1")).toBe("Capy thread t-1");
  });
});
