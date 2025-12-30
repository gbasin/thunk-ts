## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | `thunk wait` should attempt to start the web server and emit `edit_url` whenever it returns `phase: user_review`, even if the session was already in `user_review`. | Matches “auto-starts when thunk wait completes” and ensures users always get a URL. |
| A2 | Per-session tokens are generated at session creation, and older sessions missing a token will get one lazily when first accessed. | Spec says “generated on session creation,” but existing sessions need a safe fallback. |
| A3 | Auto-save draft writes count as “activity” for the 24‑hour idle timer. | Prevents the daemon from shutting down mid-edit. |
| A4 | The server should prefer `dist/web/` assets and fall back to `src/web/` when `dist/web` is missing (dev workflow). | Keeps CLI usable from source without requiring a build step. |
| A5 | Clipboard failures should be non-fatal (URL still printed). | Clipboard access can fail in CI/headless shells; UX should degrade gracefully. |

### Questions

**Q1: Should `Save & Continue` block the HTTP request until `thunk wait` finishes (potentially minutes), or return immediately after kicking off the process?**
- Context: The spec says to shell out to `thunk continue ... && thunk wait ...`, but also says “user monitors progress in terminal as before.” The blocking choice impacts UI responsiveness and server timeouts.
- My lean: Kick off `continue`, return 202/OK quickly, and let users run `thunk wait` in terminal for progress.
- **Answer:**

**Q2: Is it acceptable for the server to add a non-specified endpoint for draft autosave (e.g., `POST /api/draft/{session}`), or should we overload `POST /api/save` with a `mode` flag?**
- Context: The spec only lists `/api/save` for saving and doesn’t mention draft-specific endpoints.
- My lean: Keep `/api/save` for committed saves and add a small `POST /api/draft` endpoint for clarity (documented in code).
- **Answer:**

**Q3: For “Draft available → view diff,” do you want a true diff view (insertions/deletions), or is a simpler “show draft vs committed” side-by-side acceptable?**
- Context: A true diff likely adds a browser-side diff dependency; side-by-side is simpler and lighter.
- My lean: Use a lightweight diff (e.g., `diff` package) and render a basic inline diff in a modal.
- **Answer:**

**Q4: When `--thunk-dir` is supplied to the CLI, should the web server be forced to use that exact directory (instead of auto-discovery)?**
- Context: The server can walk upward for `.thunk`, but CLI invocations may target a non-default directory.
- My lean: Pass `--thunk-dir` (or an env) to the server so it serves the same sessions.
- **Answer:**

---

## Notes for Agents

- Keep new server/web files under 500 LOC; split utilities if needed.
- Update tests alongside changes and run `bun run lint && bun run test` per batch.

---

## Summary

Add a Bun-based daemon web server that serves a Monaco/Lit editor for session turns, with per-session auth tokens, draft autosave, and a session list page. Integrate server startup into `thunk wait`, copy the edit URL to clipboard, and add web asset bundling via a new `build:web` script. Cover new token/storage and server behaviors with tests and keep server lifecycle consistent with the 24‑hour inactivity rule.

## Tasks

- [ ] **Task 1**: Add token support to session state and utilities
  - **Files:** `src/models.ts` (modify), `src/session.ts` (modify), `src/server/auth.ts` (create)
  - **Rationale:** Persist per-session tokens in `state.yaml` and load/generate as needed; centralize token validation.
  - **Dependencies:** none

- [ ] **Task 2**: Implement daemon lifecycle + server state management
  - **Files:** `src/server/daemon.ts` (create), `src/server/index.ts` (create), `src/server/handlers.ts` (create)
  - **Rationale:** Start/stop a detached Bun server, manage `.thunk/server.json`, log to `.thunk/server.log`, and enforce idle shutdown rules.
  - **Dependencies:** Task 1

- [ ] **Task 3**: Add networking + URL construction helpers
  - **Files:** `src/server/network.ts` (create), `src/cli.ts` (modify)
  - **Rationale:** Detect local IP (with `THUNK_HOST` override), choose a free port, and construct edit/list URLs for CLI output.
  - **Dependencies:** Task 2

- [ ] **Task 4**: Integrate web server startup into `thunk wait`
  - **Files:** `src/cli.ts` (modify), `package.json` (modify)
  - **Rationale:** Start server (unless `THUNK_WEB=0`), copy URL via `clipboardy`, and include `edit_url` in JSON output.
  - **Dependencies:** Tasks 2–3

- [ ] **Task 5**: Build the web UI + bundling pipeline
  - **Files:** `src/web/index.html` (create), `src/web/list.html` (create), `src/web/editor.ts` (create), `src/web/styles.css` (create), `src/web/build.ts` (create), `package.json` (modify)
  - **Rationale:** Monaco/Lit editor with autosave, draft recovery, and shortcuts; bundle to `dist/web` via `bun run build:web`.
  - **Dependencies:** Task 2

- [ ] **Task 6**: Add tests for tokens, CLI output, and server handlers
  - **Files:** `tests/server.test.ts` (create), `tests/cli.test.ts` (modify), `tests/session.test.ts` (modify)
  - **Rationale:** Maintain coverage for new state fields, auth behavior, and `edit_url` output; avoid accidental daemon startup in tests.
  - **Dependencies:** Tasks 1–5

## Risks

- **Detached server process leaks / stale PID** (severity: medium)
  - **Mitigation:** Validate PID with `process.kill(pid, 0)`, remove stale `server.json`, and shutdown on idle/no-editable sessions.
- **Monaco bundling complexity / size** (severity: medium)
  - **Mitigation:** Disable workers, bundle once in CI, and serve from `dist/web` with caching headers.
- **`Save & Continue` long-running HTTP requests** (severity: medium)
  - **Mitigation:** Prefer async kickoff + status response (if approved), or add generous server timeouts and UI feedback.
- **Clipboard failures in headless shells** (severity: low)
  - **Mitigation:** Catch clipboard errors and still print `edit_url`.

## Alternatives Considered

- **In-process server (no daemon)**: Rejected because the server must survive beyond `thunk wait` and support edits from other devices.
- **Textarea-based editor**: Rejected because Monaco is explicitly required and provides markdown ergonomics.
