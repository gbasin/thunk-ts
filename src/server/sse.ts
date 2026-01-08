import type { ActivityEvent, ProjectRegistry } from "./projects";

type SseClient = {
  controller: ReadableStreamDefaultController<string>;
};

export type SseManager = {
  handleEvents: (events: ActivityEvent[]) => Response;
  broadcast: (eventName: string, data: Record<string, unknown>) => void;
  close: () => void;
};

function serializeEvent(eventName: string, data: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseManager(registry: ProjectRegistry): SseManager {
  const clients = new Set<SseClient>();

  const broadcast = (eventName: string, data: Record<string, unknown>) => {
    const payload = serializeEvent(eventName, data);
    for (const client of clients) {
      client.controller.enqueue(payload);
    }
  };

  const onActivity = (event: ActivityEvent) => {
    broadcast("session_update", event);
  };
  registry.on("activity", onActivity);

  return {
    handleEvents(activitySnapshot: ActivityEvent[]) {
      let client: SseClient | null = null;
      const stream = new ReadableStream<string>({
        start(controller) {
          client = { controller };
          clients.add(client);
          controller.enqueue(serializeEvent("activity_snapshot", { events: activitySnapshot }));
        },
        cancel() {
          if (client) {
            clients.delete(client);
            client = null;
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
    broadcast,
    close() {
      registry.off("activity", onActivity);
      clients.clear();
    },
  };
}
