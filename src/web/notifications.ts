export type ActivityEvent = {
  id: string;
  timestamp: string;
  project_id: string;
  project_name: string;
  session_id: string;
  phase: string;
  action: "review_needed" | "approved" | "error";
};

export function getTokenFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get("t");
}

export function formatActivity(event: ActivityEvent): string {
  const action =
    event.action === "review_needed"
      ? "needs review"
      : event.action === "approved"
        ? "approved"
        : "errored";
  return `${event.project_name} · ${event.session_id} ${action}`;
}

export function openActivityStream(
  token: string | null,
  onSnapshot: (events: ActivityEvent[]) => void,
  onUpdate: (event: ActivityEvent) => void,
): EventSource | null {
  if (!token) {
    return null;
  }
  const source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  source.addEventListener("activity_snapshot", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data) as { events: ActivityEvent[] };
      onSnapshot(payload.events ?? []);
    } catch {
      // ignore malformed payloads
    }
  });
  source.addEventListener("session_update", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent).data) as ActivityEvent;
      onUpdate(payload);
    } catch {
      // ignore malformed payloads
    }
  });
  return source;
}
