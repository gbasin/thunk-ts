import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

let originalWindow: unknown;
let originalDocument: unknown;
let originalFetch: unknown;

beforeAll(async () => {
  const globalAny = globalThis as unknown as Record<string, unknown>;
  originalWindow = globalAny.window;
  originalDocument = globalAny.document;

  const registry = globalAny.customElements as CustomElementRegistry | undefined;
  if (!registry || !registry.get("pl4n-editor")) {
    const window = new Window();
    globalAny.window = window;
    globalAny.document = window.document;
    globalAny.HTMLElement = window.HTMLElement;
    globalAny.customElements = window.customElements;
  }

  globalAny.EventSource = class {
    constructor() {}
    addEventListener() {}
    close() {}
  };

  await import("../src/web/editor");
});

afterAll(() => {
  const globalAny = globalThis as unknown as Record<string, unknown>;
  if (originalWindow) {
    globalAny.window = originalWindow;
  } else {
    delete globalAny.window;
  }
  if (originalDocument) {
    globalAny.document = originalDocument;
  } else {
    delete globalAny.document;
  }
  if (originalFetch) {
    globalAny.fetch = originalFetch;
  }
});

describe("pl4n-editor", () => {
  it("loads content and updates archived/read-only state", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      session: string;
      token: string;
      projectId: string;
      globalToken: string;
      editor?: {
        setBaseline: (value: string) => void;
        setValue: (value: string) => void;
        setReadOnly: (value: boolean) => void;
      };
      loadContent?: () => Promise<void>;
      archived?: boolean;
      readOnly?: boolean;
      statusMessage?: string;
    };

    element.session = "s1";
    element.token = "t1";
    element.projectId = "p1";
    element.globalToken = "g1";
    element.editor = {
      setBaseline: () => {},
      setValue: () => {},
      setReadOnly: () => {},
    };

    originalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = (async () => {
      const payload = {
        content: "# Plan\n",
        mtime: 1,
        turn: 1,
        phase: "user_review",
        archived: true,
        readOnly: false,
        hasAutosave: false,
        autosave: null,
        snapshot: null,
      };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      } as FetchResponse;
    }) as unknown as typeof fetch;

    await (element as unknown as { loadContent: () => Promise<void> }).loadContent();

    expect(element.archived).toBe(true);
    expect(element.readOnly).toBe(false);
    expect(element.statusMessage).toBe("Ready");
  });

  it("toggles archive state via API", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      session: string;
      projectId: string;
      globalToken: string;
      archived?: boolean;
      statusMessage?: string;
      toggleArchive?: () => Promise<void>;
    };

    element.session = "s2";
    element.projectId = "p2";
    element.globalToken = "g2";
    element.archived = false;

    originalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = (async (input: RequestInfo) => {
      const url = String(input);
      expect(url).toContain("/api/projects/p2/archive/s2");
      return {
        ok: true,
        status: 200,
        json: async () => ({ archived: true }),
      } as FetchResponse;
    }) as unknown as typeof fetch;

    await (element as unknown as { toggleArchive: () => Promise<void> }).toggleArchive();

    expect(element.archived).toBe(true);
    expect(element.statusMessage).toBe("Archived");
  });
});
