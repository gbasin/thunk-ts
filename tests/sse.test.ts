import { EventEmitter } from "events";
import { describe, expect, it } from "bun:test";

import type { ActivityEvent, ProjectRegistry } from "../src/server/projects";
import { createSseManager } from "../src/server/sse";

class RegistryStub extends EventEmitter {
  on(event: "activity", listener: (event: ActivityEvent) => void): this {
    return super.on(event, listener);
  }
  off(event: "activity", listener: (event: ActivityEvent) => void): this {
    return super.off(event, listener);
  }
}

async function readChunk(stream: ReadableStream<unknown>): Promise<string> {
  const reader = stream.getReader();
  const result = await reader.read();
  await reader.cancel();
  const value = result.value;
  if (typeof value === "string") {
    return value;
  }
  const typed = value instanceof Uint8Array ? value : new Uint8Array();
  return new TextDecoder().decode(typed);
}

describe("createSseManager", () => {
  it("streams the activity snapshot on connect", async () => {
    const registry = new RegistryStub() as unknown as ProjectRegistry;
    const sse = createSseManager(registry);
    const snapshot: ActivityEvent[] = [
      {
        id: "1",
        timestamp: "2025-01-01T00:00:00Z",
        project_id: "proj",
        project_name: "Project",
        session_id: "alpha",
        phase: "user_review",
        action: "review_needed",
      },
    ];
    const response = sse.handleEvents(snapshot);
    const body = response.body as ReadableStream<unknown>;
    const text = await readChunk(body);
    expect(text).toContain("event: activity_snapshot");
    expect(text).toContain('"session_id":"alpha"');
    sse.close();
  });

  it("broadcasts activity events to connected clients", async () => {
    const registry = new RegistryStub() as unknown as ProjectRegistry;
    const sse = createSseManager(registry);
    const response = sse.handleEvents([]);
    const body = response.body as ReadableStream<unknown>;
    const reader = body.getReader();
    await reader.read(); // snapshot

    const event: ActivityEvent = {
      id: "2",
      timestamp: "2025-01-01T00:00:01Z",
      project_id: "proj",
      project_name: "Project",
      session_id: "beta",
      phase: "approved",
      action: "approved",
    };
    registry.emit("activity", event);

    const update = await reader.read();
    const payload =
      typeof update.value === "string"
        ? update.value
        : new TextDecoder().decode(update.value as Uint8Array);
    expect(payload).toContain("event: session_update");
    expect(payload).toContain('"session_id":"beta"');

    await reader.cancel();
    sse.close();
  });
});
