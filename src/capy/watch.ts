import { CapyError, type CapyClient } from "./client";
import { parseSse } from "./sse";

export async function waitForRunEnd(client: Pick<CapyClient, "stream">, id: string, sleep: (ms: number) => Promise<void> = Bun.sleep): Promise<"done" | "lost"> {
  let lastId: string | undefined;
  for (let failures = 0; failures < 5; failures++) {
    try {
      const response = await client.stream(id, lastId);
      if (!response.body) throw new Error("Empty event stream");
      for await (const frame of parseSse(response.body)) {
        if (frame.event === "heartbeat") continue;
        if (frame.event === "transcript" && frame.id) lastId = frame.id;
        if (frame.event === "done") return "done";
        if (frame.event === "error") break;
      }
      await sleep(2000);
    } catch (error) {
      await sleep(error instanceof CapyError && error.status === 429 ? (error.retryAfterSeconds ?? 2) * 1000 : 2000);
    }
  }
  return "lost";
}
