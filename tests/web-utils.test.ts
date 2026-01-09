import { describe, expect, it } from "bun:test";

import { buildLineDiff } from "../src/web/diff-render";
import { formatActivity, getTokenFromLocation, openActivityStream } from "../src/web/notifications";

class EventSourceStub {
  url: string;
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(name: string, handler: (event: MessageEvent) => void) {
    const existing = this.listeners.get(name) ?? [];
    existing.push(handler);
    this.listeners.set(name, existing);
  }

  emit(name: string, payload: unknown) {
    const handlers = this.listeners.get(name) ?? [];
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const handler of handlers) {
      handler(event);
    }
  }
}

describe("diff-render", () => {
  it("reports line additions and removals", () => {
    const diff = buildLineDiff("a\nb\n", "a\nc\n");
    const types = diff.map((entry) => entry.type);
    expect(types.some((type) => type === "modify" || type === "remove")).toBe(true);
    expect(types.some((type) => type === "modify" || type === "add")).toBe(true);
  });

  it("reports inline modifications as modify with char changes", () => {
    const diff = buildLineDiff("hello\n", "hallo\n");
    const modify = diff.find((entry) => entry.type === "modify");
    expect(modify).toBeDefined();
    expect(modify?.chars?.length).toBeGreaterThan(0);
  });
});

describe("notifications", () => {
  it("formats activity strings", () => {
    const text = formatActivity({
      id: "1",
      timestamp: "2025-01-01T00:00:00Z",
      project_id: "proj",
      project_name: "Project",
      session_id: "alpha",
      phase: "user_review",
      action: "review_needed",
    });
    expect(text).toContain("Project · alpha needs review");
  });

  it("reads token from the location", () => {
    const originalWindow = (globalThis as { window?: Window }).window;
    (globalThis as { window: Window }).window = {
      location: { search: "?t=abc123" },
    } as Window;
    expect(getTokenFromLocation()).toBe("abc123");
    if (originalWindow) {
      (globalThis as { window: Window }).window = originalWindow;
    } else {
      delete (globalThis as { window?: Window }).window;
    }
  });

  it("wires activity stream handlers", () => {
    const originalEventSource = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    (globalThis as { EventSource: typeof EventSource }).EventSource =
      EventSourceStub as unknown as typeof EventSource;
    const originalWindow = (globalThis as { window?: Window }).window;
    (globalThis as { window: Window }).window = { location: { search: "?t=token" } } as Window;

    const snapshotEvents: unknown[] = [];
    const updateEvents: unknown[] = [];
    const source = openActivityStream(
      "token",
      (events) => snapshotEvents.push(events),
      (event) => updateEvents.push(event),
    ) as unknown as EventSourceStub;

    source.emit("activity_snapshot", { events: [{ id: "snap" }] });
    source.emit("session_update", { id: "update" });

    expect(snapshotEvents.length).toBe(1);
    expect(updateEvents.length).toBe(1);

    if (originalEventSource) {
      (globalThis as { EventSource: typeof EventSource }).EventSource = originalEventSource;
    } else {
      delete (globalThis as { EventSource?: typeof EventSource }).EventSource;
    }
    if (originalWindow) {
      (globalThis as { window: Window }).window = originalWindow;
    } else {
      delete (globalThis as { window?: Window }).window;
    }
  });
});
