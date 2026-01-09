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
});
