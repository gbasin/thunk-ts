import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { TextSelection } from "prosemirror-state";
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

  it("renders line numbers for logical lines", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = "# Title\n\nParagraph line one\nParagraph line two\n";
    const editor = new PlanEditor(root, { value: content, baseline: content });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const lineNumbers = root.querySelectorAll(".plan-editor-line-number");
    expect(lineNumbers.length).toBeGreaterThan(0);

    editor.destroy();
    root.remove();
  });

  it("collapses content under headings", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = "# Title\n\nParagraph\n\n## Subheading\n\nMore text\n";
    const editor = new PlanEditor(root, { value: content, baseline: content });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const toggle = root.querySelector(".plan-editor-line-toggle") as HTMLElement | null;
    expect(toggle).not.toBeNull();
    toggle?.click();

    const collapsed = root.querySelectorAll(".pm-collapsed");
    expect(collapsed.length).toBeGreaterThan(0);

    editor.destroy();
    root.remove();
  });

  it("shows markdown prefix for active heading", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = "## Title\n";
    const editor = new PlanEditor(root, { value: content, baseline: content });

    const view = (editor as unknown as { view: unknown }).view as {
      state: { doc: { descendants: (fn: (node: any, pos: number) => boolean) => void } };
      dispatch: (tr: unknown) => void;
    };
    let headingPos: number | null = null;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        headingPos = pos;
        return false;
      }
      return true;
    });
    expect(headingPos).not.toBeNull();
    if (headingPos !== null) {
      const cursorPos = headingPos + 1;
      const tr = (view as any).state.tr.setSelection(
        TextSelection.create((view as any).state.doc, cursorPos),
      );
      view.dispatch(tr);
    }

    const headingEl = root.querySelector("h2") as HTMLElement | null;
    expect(headingEl).not.toBeNull();
    expect(headingEl?.classList.contains("pm-heading-editing")).toBe(true);
    expect(headingEl?.getAttribute("data-md-prefix")).toBe("## ");

    editor.destroy();
    root.remove();
  });

  it("adjusts heading level via markdown-style edits", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = "## Title\n";
    const editor = new PlanEditor(root, { value: content, baseline: content });
    const view = (editor as unknown as { view: any }).view as any;

    const findHeading = (): { pos: number; node: any } | null => {
      let found: { pos: number; node: any } | null = null;
      view.state.doc.descendants((node: any, pos: number) => {
        if (node.type.name === "heading") {
          found = { pos, node };
          return false;
        }
        return true;
      });
      return found;
    };

    const setCursorToHeadingStart = () => {
      const heading = findHeading();
      if (!heading) {
        return null;
      }
      const cursorPos = heading.pos + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursorPos)));
      return cursorPos;
    };

    const cursorPos = setCursorToHeadingStart();
    expect(cursorPos).not.toBeNull();

    const handled = view.someProp("handleTextInput", (f: any) =>
      f(view, cursorPos, cursorPos, "#"),
    );
    expect(handled).toBe(true);
    expect(findHeading()?.node.attrs.level).toBe(3);

    setCursorToHeadingStart();
    view.someProp("handleKeyDown", (f: any) =>
      f(view, new window.KeyboardEvent("keydown", { key: "Backspace" })),
    );
    expect(findHeading()?.node.attrs.level).toBe(2);

    setCursorToHeadingStart();
    view.someProp("handleKeyDown", (f: any) =>
      f(view, new window.KeyboardEvent("keydown", { key: "Backspace" })),
    );
    expect(findHeading()?.node.attrs.level).toBe(1);

    setCursorToHeadingStart();
    view.someProp("handleKeyDown", (f: any) =>
      f(view, new window.KeyboardEvent("keydown", { key: "Backspace" })),
    );
    expect(findHeading()).toBeNull();
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");

    editor.destroy();
    root.remove();
  });

  it("shows markdown prefix for active list item", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = "- One\n- Two";
    const editor = new PlanEditor(root, { value: content, baseline: content });

    const view = (editor as unknown as { view: unknown }).view as {
      state: { doc: { descendants: (fn: (node: any, pos: number) => boolean) => void } };
      dispatch: (tr: unknown) => void;
    };
    let paragraphPos: number | null = null;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph") {
        paragraphPos = pos;
        return false;
      }
      return true;
    });
    expect(paragraphPos).not.toBeNull();
    if (paragraphPos !== null) {
      const cursorPos = paragraphPos + 1;
      const tr = (view as any).state.tr.setSelection(
        TextSelection.create((view as any).state.doc, cursorPos),
      );
      view.dispatch(tr);
    }

    const prefix = root.querySelector(".pm-list-editing-prefix") as HTMLElement | null;
    expect(prefix).not.toBeNull();
    expect(prefix?.textContent).toBe("- ");

    editor.destroy();
    root.remove();
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

  it("keeps a single table row when delete is clicked", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = ["| A | B |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    const editor = new PlanEditor(root, { value: content, baseline: content });

    const table = root.querySelector(".table-widget table") as HTMLTableElement | null;
    const initialRows = table?.querySelectorAll("tbody tr").length ?? 0;
    const deleteBtn = root.querySelector(
      ".table-row-actions .table-delete-btn",
    ) as HTMLButtonElement | null;
    deleteBtn?.click();
    const afterRows = table?.querySelectorAll("tbody tr").length ?? 0;
    expect(afterRows).toBe(initialRows);

    editor.destroy();
    root.remove();
  });

  it("updates table cell content on blur", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = ["| A | B |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    const editor = new PlanEditor(root, { value: content, baseline: content });

    const firstCell = root.querySelector("tbody td[contenteditable]") as HTMLElement | null;
    expect(firstCell).not.toBeNull();
    if (firstCell) {
      firstCell.textContent = "9";
      firstCell.dispatchEvent(new Event("blur"));
    }

    expect(editor.getValue()).toContain("| 9 | 2 |");

    editor.destroy();
    root.remove();
  });

  it("zooms diagram viewer with buttons", async () => {
    const { PlanEditor } = await import("../src/web/plan-editor");
    const root = document.createElement("div");
    document.body.appendChild(root);
    const content = "```\n┌─┐\n└─┘\n```\n";
    const editor = new PlanEditor(root, { value: content, baseline: content });

    const expandBtn = root.querySelector(".diagram-expand-btn") as HTMLButtonElement | null;
    expandBtn?.click();

    const zoomLabel = document.querySelector(".diagram-viewer-zoom-label") as HTMLElement | null;
    const zoomButtons = document.querySelectorAll(".diagram-viewer-zoom button");
    const zoomIn = zoomButtons[zoomButtons.length - 1] as HTMLButtonElement | undefined;
    zoomIn?.click();
    expect(zoomLabel?.textContent).toBe("125%");

    editor.destroy();
    root.remove();
  });
});
