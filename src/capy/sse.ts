export type Frame = { event: string; id?: string; data: string };

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];

  function frame(): Frame | undefined {
    if (!data.length) return;
    const result = { event, id, data: data.join("\n") };
    event = "message";
    id = undefined;
    data = [];
    return result;
  }

  function line(raw: string): Frame | undefined {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!text) return frame();
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const key = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (key === "event") event = value;
    if (key === "id" && !value.includes("\0")) id = value;
    if (key === "data") data.push(value);
  }

  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const next = line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (next) yield next;
      }
      if (chunk.done) {
        if (buffer) {
          const next = line(buffer);
          if (next) yield next;
        }
        const next = frame();
        if (next) yield next;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
