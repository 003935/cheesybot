import { expect, test } from "bun:test";
import { parseSse } from "../src/capy/sse";

test("parses comments, multiline data, IDs and split frames", async () => {
  const encoder = new TextEncoder();
  const chunks = [": keepalive\r\nevent: transcript\r\nid: cursor-1\r\ndata: first\r\ndata: sec", "ond\r\n\r\nevent: done\ndata: {}\n\n"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of parseSse(body)) frames.push(frame);
  expect(frames).toEqual([
    { event: "transcript", id: "cursor-1", data: "first\nsecond" },
    { event: "done", id: undefined, data: "{}" },
  ]);
});
