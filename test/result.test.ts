import { describe, expect, test } from "bun:test";
import { resultFor } from "../src/result";
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
