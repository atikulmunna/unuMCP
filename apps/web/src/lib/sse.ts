// Minimal Server-Sent Events frame parser (P4-8). We consume the test-log stream
// with `fetch` (so the Bearer token can ride the Authorization header — native
// EventSource can't send headers), which means parsing the wire format ourselves.
// Pure and incremental: feed it the running buffer, get back complete events plus
// the unparsed remainder to carry into the next read.

export interface SseParseResult<T> {
  events: T[];
  /** The trailing partial frame to prepend to the next chunk. */
  rest: string;
}

export function parseSse<T = unknown>(buffer: string): SseParseResult<T> {
  const events: T[] = [];
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data) {
      try {
        events.push(JSON.parse(data) as T);
      } catch {
        // Ignore non-JSON frames (SSE comments / heartbeats).
      }
    }
    boundary = rest.indexOf("\n\n");
  }
  return { events, rest };
}
