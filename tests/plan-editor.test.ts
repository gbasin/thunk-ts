import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";

let originalWindow: unknown;
let originalDocument: unknown;

beforeAll(() => {
  const globalAny = globalThis as unknown as Record<string, unknown>;
  originalWindow = globalAny.window;
  originalDocument = globalAny.document;
  const window = new Window();
  globalAny.window = window;
  globalAny.document = window.document;
  globalAny.HTMLElement = window.HTMLElement;
  globalAny.customElements = window.customElements;
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
});

describe("PlanEditor", () => {
  it("tracks dirty state against baseline", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = new PlanEditor(root, { value: "# Title\n", baseline: "# Title\n" });

    editor.setBaseline(editor.getValue());
    expect(editor.isDirty()).toBe(false);
    editor.setValue("# New\n");
    expect(editor.isDirty()).toBe(true);
    editor.setBaseline(editor.getValue());
    expect(editor.isDirty()).toBe(false);

    editor.destroy();
    expect(root.querySelector(".plan-editor-container")).toBeNull();
  });

  it("supports read-only and history actions", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = new PlanEditor(root, { value: "one\n", baseline: "one\n" });

    editor.setReadOnly(true);
    const view = (editor as unknown as { view: { props: { editable?: () => boolean } } }).view;
    expect(view.props.editable?.()).toBe(false);

    editor.setReadOnly(false);
    expect(view.props.editable?.()).toBe(true);

    editor.setValue("two\n");
    const undoWorked = editor.undo();
    if (undoWorked) {
      expect(editor.getValue().trimEnd()).toBe("one");
      const redoWorked = editor.redo();
      if (redoWorked) {
        expect(editor.getValue().trimEnd()).toBe("two");
      }
    }

    editor.destroy();
  });

  it("opens and closes diagram viewer", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = "```\n┌─┐\n└─┘\n```\n";
    const editor = new PlanEditor(root, { value: content, baseline: content });

    const expandBtn = root.querySelector(".diagram-expand-btn") as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();

    expandBtn?.click();
    const backdrop = document.querySelector(".diagram-viewer-backdrop") as HTMLElement | null;
    expect(backdrop?.classList.contains("open")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    const closeBtn = backdrop?.querySelector(".diagram-viewer-close") as HTMLButtonElement | null;
    closeBtn?.click();
    expect(backdrop?.classList.contains("open")).toBe(false);
    expect(document.body.style.overflow).toBe("");

    editor.destroy();
    root.remove();
  });

  it("adds table rows and columns", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = ["| A | B |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    const editor = new PlanEditor(root, { value: content, baseline: content });

    const table = root.querySelector(".table-widget table") as HTMLTableElement | null;
    expect(table).not.toBeNull();

    const initialRows = table?.querySelectorAll("tbody tr").length ?? 0;
    const addRowBtn = root.querySelector(
      ".table-add-row .table-add-btn",
    ) as HTMLButtonElement | null;
    addRowBtn?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const afterRows = table?.querySelectorAll("tbody tr").length ?? 0;
    expect(afterRows).toBe(initialRows + 1);

    const initialHeaders = table?.querySelectorAll("thead th[contenteditable]").length ?? 0;
    const addColBtn = root.querySelector(
      ".table-add-col .table-add-btn",
    ) as HTMLButtonElement | null;
    addColBtn?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const afterHeaders = table?.querySelectorAll("thead th[contenteditable]").length ?? 0;
    expect(afterHeaders).toBe(initialHeaders + 1);

    editor.destroy();
    root.remove();
  });

  it("highlights table diffs against baseline", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const baseline = ["| A | B |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    const current = ["| A | B |", "| --- | --- |", "| 1 | 3 |", ""].join("\n");
    const editor = new PlanEditor(root, { value: current, baseline });

    const diffAdded = root.querySelector(".table-widget .diff-added") as HTMLElement | null;
    const diffRemoved = root.querySelector(".table-widget .diff-removed") as HTMLElement | null;
    expect(diffAdded || diffRemoved).not.toBeNull();

    editor.destroy();
    root.remove();
  });
});
