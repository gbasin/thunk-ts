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

    const archivedIndicator = document.createElement("span");
    archivedIndicator.id = "info-archived";
    archivedIndicator.textContent = "NO";
    document.body.appendChild(archivedIndicator);

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
    expect(element.statusMessage?.trim()).toBe("Ready");
    expect(archivedIndicator.textContent?.trim()).toBe("YES");
  });

  it("falls back to test content when API fails for test session", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      session: string;
      token: string;
      projectId: string;
      editor?: {
        setBaseline: (value: string) => void;
        setValue: (value: string) => void;
        setReadOnly: (value: boolean) => void;
      };
      loadContent?: () => Promise<void>;
      statusMessage?: string;
    };

    let valueSet = "";
    element.session = "test-session";
    element.token = "t1";
    element.projectId = "p1";
    element.editor = {
      setBaseline: () => {},
      setValue: (value) => {
        valueSet = value;
      },
      setReadOnly: () => {},
    };

    originalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = (async () => {
      return {
        ok: false,
        status: 503,
        json: async () => ({}),
      } as FetchResponse;
    }) as unknown as typeof fetch;

    await (element as unknown as { loadContent: () => Promise<void> }).loadContent();

    expect(element.statusMessage?.trim()).toBe("Test mode - Ready");
    expect(valueSet).toContain("Implementation Plan");
  });

  it("saves content and clears autosave state", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      session: string;
      token: string;
      projectId: string;
      mtime?: number;
      readOnly?: boolean;
      showAutosaveBanner?: boolean;
      autosaveContent?: string | null;
      editor?: {
        getValue: () => string;
        setBaseline: (value: string) => void;
      };
      save?: () => Promise<void>;
      statusMessage?: string;
    };

    let baselineSet = "";
    element.session = "s-save";
    element.token = "t-save";
    element.projectId = "p-save";
    element.readOnly = false;
    element.mtime = 1;
    element.showAutosaveBanner = true;
    element.autosaveContent = "draft";
    element.editor = {
      getValue: () => "new content",
      setBaseline: (value) => {
        baselineSet = value;
      },
    };

    originalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ mtime: 2 }),
      } as FetchResponse;
    }) as unknown as typeof fetch;

    await (element as unknown as { save: () => Promise<void> }).save();

    expect(element.statusMessage?.trim()).toBe("Saved");
    expect(element.mtime).toBe(2);
    expect(element.showAutosaveBanner).toBe(false);
    expect(element.autosaveContent).toBeNull();
    expect(baselineSet).toBe("new content");
  });

  it("approves the plan successfully", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      session: string;
      token: string;
      projectId: string;
      editor?: Record<string, unknown>;
      readOnly?: boolean;
      phase?: string;
      approve?: () => Promise<void>;
      statusMessage?: string;
    };

    element.session = "s-approve";
    element.token = "t-approve";
    element.projectId = "p-approve";
    element.editor = {};
    element.readOnly = false;
    element.phase = "user_review";

    originalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      } as FetchResponse;
    }) as unknown as typeof fetch;

    await (element as unknown as { approve: () => Promise<void> }).approve();

    expect(element.phase).toBe("approved");
    expect(element.readOnly).toBe(true);
    expect(element.statusMessage?.trim()).toBe("Plan approved!");
  });

  it("continues run by approving when unchanged", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      lastLoadedContent?: string;
      editor?: {
        getValue: () => string;
      };
      continueRun?: () => Promise<void>;
      approve?: () => Promise<void>;
    };

    let approveCalled = false;
    const originalConfirm = window.confirm;
    window.confirm = () => true;

    element.lastLoadedContent = "same";
    element.editor = {
      getValue: () => "same",
    };
    element.approve = async () => {
      approveCalled = true;
    };

    try {
      await (element as unknown as { continueRun: () => Promise<void> }).continueRun();
    } finally {
      window.confirm = originalConfirm;
    }

    expect(approveCalled).toBe(true);
  });

  it("handles stale conflicts on continue", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      session: string;
      token: string;
      projectId: string;
      mtime?: number;
      editor?: {
        getValue: () => string;
      };
      confirmContinue?: () => Promise<void>;
      continuing?: boolean;
      showContinueConfirm?: boolean;
      statusMessage?: string;
    };

    element.session = "s-continue";
    element.token = "t-continue";
    element.projectId = "p-continue";
    element.mtime = 1;
    element.editor = {
      getValue: () => "changed",
    };

    originalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = (async () => {
      return {
        ok: false,
        status: 409,
        json: async () => ({ mtime: 4 }),
      } as FetchResponse;
    }) as unknown as typeof fetch;

    await (element as unknown as { confirmContinue: () => Promise<void> }).confirmContinue();

    expect(element.mtime).toBe(4);
    expect(element.continuing).toBe(false);
    expect(element.statusMessage?.trim()).toBe("Stale copy. Reload to continue.");
  });

  it("updates archived indicator text and class", () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      archived?: boolean;
      updateArchivedIndicator?: () => void;
    };

    const existingIndicator = document.getElementById("info-archived");
    existingIndicator?.remove();

    const archivedIndicator = document.createElement("span");
    archivedIndicator.id = "info-archived";
    archivedIndicator.textContent = "NO";
    document.body.appendChild(archivedIndicator);

    element.archived = true;
    (element as unknown as { updateArchivedIndicator: () => void }).updateArchivedIndicator();
    expect(archivedIndicator.textContent?.trim()).toBe("YES");
    expect(archivedIndicator.classList.contains("status-archived")).toBe(true);

    element.archived = false;
    (element as unknown as { updateArchivedIndicator: () => void }).updateArchivedIndicator();
    expect(archivedIndicator.textContent?.trim()).toBe("NO");
    expect(archivedIndicator.classList.contains("status-archived")).toBe(false);
  });

  it("reports archive failures without flipping state", async () => {
    const EditorClass = customElements.get("pl4n-editor") as {
      new (): HTMLElement;
    };
    const element = new EditorClass() as HTMLElement & {
      session: string;
      projectId: string;
      globalToken: string;
      archived?: boolean;
      toggleArchive?: () => Promise<void>;
      statusMessage?: string;
    };

    element.session = "s-archive";
    element.projectId = "p-archive";
    element.globalToken = "g-archive";
    element.archived = false;

    originalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = (async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      } as FetchResponse;
    }) as unknown as typeof fetch;

    await (element as unknown as { toggleArchive: () => Promise<void> }).toggleArchive();

    expect(element.archived).toBe(false);
    expect(element.statusMessage?.trim()).toBe("Archive failed (500)");
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
    expect(element.statusMessage?.trim()).toBe("Archived");
  });
});
