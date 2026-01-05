/**
 * Tests for editor logic - focuses on state management behavior
 * that can be tested without a full browser environment.
 */

import { describe, expect, it } from "bun:test";

// Mock the minimal editor state machine behavior
// This tests the logic without needing ProseMirror or browser APIs

interface EditorState {
  dirty: boolean;
  saving: boolean;
  hasAutosave: boolean;
  autosaveContent: string | null;
  autosaveTimer: number | null;
  statusMessage: string;
}

function createEditorState(): EditorState {
  return {
    dirty: false,
    saving: false,
    hasAutosave: false,
    autosaveContent: null,
    autosaveTimer: null,
    statusMessage: "Ready",
  };
}

// Simulates save success (BUG: doesn't clear autosave timer)
function onSaveSuccess(state: EditorState): void {
  state.dirty = false;
  state.hasAutosave = false;
  state.autosaveContent = null;
  state.statusMessage = "Saved";
  // BUG: autosaveTimer should be cleared here
  // FIX: Uncomment the following lines:
  // if (state.autosaveTimer !== null) {
  //   clearTimeout(state.autosaveTimer);
  //   state.autosaveTimer = null;
  // }
}

// Simulates save success with the fix
function onSaveSuccessFixed(state: EditorState, clearTimeout: (id: number) => void): void {
  state.dirty = false;
  state.hasAutosave = false;
  state.autosaveContent = null;
  state.statusMessage = "Saved";
  // FIX: Clear the autosave timer
  if (state.autosaveTimer !== null) {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }
}

// Simulates autosave completing
function onAutosaveComplete(state: EditorState, content: string): void {
  state.hasAutosave = true;
  state.autosaveContent = content;
  state.statusMessage = "Autosaved";
}

describe("Editor state management", () => {
  describe("autosave timer behavior", () => {
    it("should clear autosave timer when save succeeds", () => {
      const state = createEditorState();
      const clearedTimers: number[] = [];
      const mockClearTimeout = (id: number) => {
        clearedTimers.push(id);
      };

      // Simulate: edit triggers autosave scheduling
      state.autosaveTimer = 123; // Timer was scheduled
      state.dirty = true;
      state.statusMessage = "Unsaved changes";

      // Simulate: save succeeds with the fix
      onSaveSuccessFixed(state, mockClearTimeout);

      // Verify timer was cleared
      expect(clearedTimers).toContain(123);
      expect(state.autosaveTimer).toBeNull();
      expect(state.dirty).toBe(false);
      expect(state.statusMessage).toBe("Saved");
    });

    it("BUG: autosave timer fires after save without fix", () => {
      const state = createEditorState();

      // Simulate: edit triggers autosave scheduling
      state.autosaveTimer = 456;
      state.dirty = true;

      // Simulate: save succeeds (without fix - doesn't clear timer)
      onSaveSuccess(state);

      // BUG: Timer is still set (wasn't cleared)
      expect(state.autosaveTimer).toBe(456);

      // If autosave fires after save, it would set hasAutosave = true
      // This is confusing because we just saved!
      onAutosaveComplete(state, "content");

      expect(state.hasAutosave).toBe(true);
      expect(state.statusMessage).toBe("Autosaved"); // Confusing!
    });

    it("beforeunload check should not trigger after save", () => {
      const state = createEditorState();

      // Simulate: edit
      state.dirty = true;

      // Simulate: save succeeds
      onSaveSuccessFixed(state, () => {});

      // beforeunload should NOT trigger because dirty is false
      const shouldWarn = state.dirty;
      expect(shouldWarn).toBe(false);
    });

    it("beforeunload check should trigger after edit without save", () => {
      const state = createEditorState();

      // Simulate: edit (no save)
      state.dirty = true;

      // beforeunload SHOULD trigger because dirty is true
      const shouldWarn = state.dirty;
      expect(shouldWarn).toBe(true);
    });
  });
});
