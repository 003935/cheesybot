export type Thread = { id: string; status: "working" | "waiting" | "idle" | "failed" | "archived" };
export type TranscriptMessage = { id: string; source: "user" | "assistant" | "tool"; text: string; createdAt: string };
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type TranscriptPage = { items: TranscriptMessage[]; cursor: string | null; beforeCursor: string | null };

export class CapyError extends Error {
  constructor(public readonly tag: string, public readonly status: number, public readonly retryAfterSeconds?: number) {
    super(tag);
    this.name = "CapyError";
  }
}

export function createCapyClient(apiKey: string, baseUrl: string, request: Fetch = fetch) {
  const root = baseUrl.replace(/\/$/, "");

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await request(`${root}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...init.headers },
    });
    if (response.ok) return response;
    const body: unknown = await response.json().catch(() => null);
    const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const tag = typeof payload._tag === "string" ? payload._tag : `HTTP ${response.status}`;
    const retry = typeof payload.retryAfterSeconds === "number" ? payload.retryAfterSeconds : Number(response.headers.get("retry-after"));
    throw new CapyError(tag, response.status, Number.isFinite(retry) && retry >= 0 ? retry : undefined);
  }

  return {
    async createThread(input: { requestId: string; projectId: string; message: string; title: string }): Promise<Thread> {
      const response = await call("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, pullRequestAuthor: "capy" }),
      });
      return response.json() as Promise<Thread>;
    },
    async getThread(id: string): Promise<Thread> {
      return (await call(`/threads/${encodeURIComponent(id)}`)).json() as Promise<Thread>;
    },
    async getTranscript(id: string): Promise<TranscriptMessage[]> {
      const items: TranscriptMessage[] = [];
      let after: string | null = null;
      let stalled = 0;
      while (true) {
        const query = after ? `?after=${encodeURIComponent(after)}` : "";
        const page = await (await call(`/threads/${encodeURIComponent(id)}/messages${query}`)).json() as TranscriptPage;
        items.push(...page.items);
        if (!page.cursor) return items;
        if (page.cursor === after) {
          if (++stalled === 5) throw new Error("Transcript pagination stalled");
          await Bun.sleep(1000);
        } else {
          stalled = 0;
          after = page.cursor;
        }
      }
    },
    async stream(id: string, after?: string): Promise<Response> {
      const query = new URLSearchParams({ until: "run" });
      if (after) query.set("after", after);
      return call(`/threads/${encodeURIComponent(id)}/stream?${query}`, { headers: { Accept: "text/event-stream" } });
    },
  };
}

export type CapyClient = ReturnType<typeof createCapyClient>;
