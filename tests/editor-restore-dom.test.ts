import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";

function setupDom() {
  const window = new Window({ url: "http://localhost" });
  const globalAny = globalThis as unknown as Record<string, unknown>;
  globalAny.window = window;
  globalAny.document = window.document;
  globalAny.HTMLElement = window.HTMLElement;
  globalAny.customElements = window.customElements;
  globalAny.Node = window.Node;
  globalAny.Text = window.Text;
  globalAny.DOMParser = window.DOMParser;
  globalAny.MutationObserver = window.MutationObserver;
  globalAny.Event = window.Event;
  globalAny.KeyboardEvent = window.KeyboardEvent;
  globalAny.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalAny.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalAny.getComputedStyle = window.getComputedStyle.bind(window);
}

describe("Editor restore (DOM)", () => {
  it("updates the editor container when restoring autosave", async () => {
    setupDom();

    await import("../src/web/editor");
    const { PlanEditor } = await import("../src/web/plan-editor.js");

    const EditorCtor = customElements.get("pl4n-editor");
    expect(EditorCtor).toBeTruthy();
    if (!EditorCtor) {
      throw new Error("pl4n-editor not registered");
    }

    const host = new EditorCtor();
    const container = document.createElement("div");
    document.body.append(container);

    const editor = new PlanEditor(container, {
      value: "initial",
      baseline: "initial",
      readOnly: false,
      onChange: () => {},
    });

    (host as any).editor = editor;
    (host as any).autosaveContent = "restored content";
    (host as any).discardAutosave = async () => {
      (host as any).showAutosaveBanner = false;
      (host as any).autosaveContent = null;
    };

    await (host as any).restoreAutosave();

    const view = (editor as any).view as { state: { doc: { textContent: string } } };

    expect(editor.getValue()).toBe("restored content");
    expect(view.state.doc.textContent).toBe("restored content");
  });
});
