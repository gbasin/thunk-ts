## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | `thunk wait` should attempt to start the web server and emit `edit_url` whenever it returns `phase: user_review`, even if the session was already in `user_review`. | Matches “auto-starts when thunk wait completes” and ensures users always get a URL. |
| A2 | Existing sessions missing a per-session token get one lazily (persisted into `state.yaml`). | Needed for backward compatibility with pre-web sessions. |
| A3 | Draft auto-save writes count as “activity” for the 24‑hour idle timer. | Prevents the daemon from shutting down mid-edit. |
| A4 | Web assets are served from `dist/web/` when present and fall back to `src/web/` in dev. | Keeps source installs usable without a build step. |
| A5 | Clipboard failures are non-fatal; the URL is still printed. | Clipboard access can fail in headless/SSH environments. |
| A6 | Token format is URL-safe and moderately short (e.g., base64url 16 chars), not necessarily UUIDs. | Example shows short tokens; shorter is friendlier in URLs. |
| A7 | No new CLI commands are required unless you want a manual `thunk server` command for dev/debug. | Spec doesn’t mention new commands; keep scope minimal by default. |

### Questions

**Q1: Should `Save & Continue` block the HTTP request until `thunk wait` finishes, or return immediately after starting the process?**
- Context: Blocking could hold requests for minutes and complicate server timeouts; returning early matches “user monitors progress in terminal.”
- My lean: Return immediately after starting `thunk continue`, and let users run `thunk wait` in the terminal for progress.
- **Answer:**

**Q2: Do you want a dedicated draft endpoint (e.g., `POST /api/draft/{session}`) or should draft writes go through `/api/save` with a mode flag?**
- Context: The spec doesn’t list a draft endpoint; adding one is clearer but adds API surface.
- My lean: Add a small `/api/draft` endpoint to keep commit vs draft semantics explicit.
- **Answer:**

**Q3: For “Draft available → view diff,” do you want a real diff view or a simpler side-by-side (committed vs draft)?**
- Context: A true diff means extra client logic or library; side‑by‑side is simpler but less precise.
- My lean: Simple inline diff (using existing `diff` package) rendered in a modal.
- **Answer:**

**Q4: Should the server honor `--thunk-dir` explicitly (passed from CLI) even if auto-discovery would find a different `.thunk`?**
- Context: CLI invocations may target non-default directories; mismatch would be confusing.
- My lean: Always pass the CLI’s thunk dir to the server and skip auto-discovery in that case.
- **Answer:**

**Q5: Do you want an optional `thunk server` command for manual start/stop/status, or keep all server management implicit?**
- Context: Helpful for dev, but not required by the spec and adds surface area.
- My lean: Keep implicit only unless you want explicit control.
- **Answer:**

---

## Notes for Agents

- Keep new server/web files under 500 LOC; split helpers if needed.
- Avoid spawning the real daemon in tests; favor handler-level or module-level tests.

---

## Summary

Implement a Bun-based detached web server that serves a Monaco/Lit editor for session turns with per-session auth tokens, a global list page, and draft autosave. Integrate server startup into `thunk wait`, generate edit URLs using the local network IP, and copy them to clipboard with graceful fallback. Add a `build:web` pipeline to bundle the web UI, and cover token/auth and save flows with tests.

## Tasks

- [ ] **Task 1**: Extend session state for per-session tokens
  - **Files:** `src/models.ts` (modify), `src/session.ts` (modify)
  - **Rationale:** Persist `session_token` in `state.yaml` and load it cleanly for auth.
  - **Dependencies:** none

- [ ] **Task 2**: Add auth utilities for session/global tokens
  - **Files:** `src/server/auth.ts` (create)
  - **Rationale:** Centralize token generation/validation and global token storage in `.thunk/token`.
  - **Dependencies:** Task 1

- [ ] **Task 3**: Implement daemon lifecycle + server state
  - **Files:** `src/server/daemon.ts` (create)
  - **Rationale:** Manage detached Bun server, `.thunk/server.json`, and `.thunk/server.log`.
  - **Dependencies:** Task 2

- [ ] **Task 4**: Implement HTTP server and handlers
  - **Files:** `src/server/index.ts` (create), `src/server/handlers.ts` (create)
  - **Rationale:** Bun.serve routing, auth checks, file IO for load/save/draft, and error responses.
  - **Dependencies:** Tasks 1–3

- [ ] **Task 5**: Add network/URL helpers for local IP + port
  - **Files:** `src/server/network.ts` (create)
  - **Rationale:** Determine bind IP (with `THUNK_HOST` override) and construct edit/list URLs.
  - **Dependencies:** Task 3

- [ ] **Task 6**: Integrate web server into `thunk wait`
  - **Files:** `src/cli.ts` (modify), `package.json` (modify)
  - **Rationale:** Auto-start server (unless `THUNK_WEB=0`), ensure tokens, copy URL, and emit `edit_url`.
  - **Dependencies:** Tasks 2–5

- [ ] **Task 7**: Build web UI + bundling pipeline
  - **Files:** `src/web/index.html` (create), `src/web/list.html` (create), `src/web/editor.ts` (create), `src/web/styles.css` (create), `src/web/build.ts` (create), `package.json` (modify)
  - **Rationale:** Monaco/Lit editor with autosave, draft recovery, keyboard shortcuts, and system theme.
  - **Dependencies:** Task 4

- [ ] **Task 8**: Add draft autosave + staleness detection
  - **Files:** `src/server/handlers.ts` (modify), `src/web/editor.ts` (modify)
  - **Rationale:** Save drafts (`001-draft.md`), detect external edits via mtime, and avoid overwrites.
  - **Dependencies:** Task 7

- [ ] **Task 9**: Implement Save & Continue behavior
  - **Files:** `src/server/handlers.ts` (modify), `src/web/editor.ts` (modify)
  - **Rationale:** Save content then trigger `thunk continue` (and optionally `thunk wait`) per decision in Q1.
  - **Dependencies:** Task 6

- [ ] **Task 10**: Add tests for tokens, CLI output, and handlers
  - **Files:** `tests/session.test.ts` (modify), `tests/cli.test.ts` (modify), `tests/server.test.ts` (create)
  - **Rationale:** Maintain coverage for new state fields, auth checks, and URL emission.
  - **Dependencies:** Tasks 1–9

- [ ] **Task 11**: Update docs (optional but recommended)
  - **Files:** `README.md` (modify)
  - **Rationale:** Document web editor usage, `THUNK_WEB`, and network/clipboard caveats.
  - **Dependencies:** Task 6

## Risks

- **Daemon detachment quirks across platforms** (severity: medium)
  - **Mitigation:** Validate PID via `process.kill(pid, 0)`, remove stale `server.json`, and log startup failures.
- **Monaco bundling complexity/size** (severity: medium)
  - **Mitigation:** Disable workers, bundle only markdown support, and ship `dist/web` from CI.
- **Long-running `Save & Continue` requests** (severity: medium)
  - **Mitigation:** Return quickly and guide users back to terminal (per Q1 decision).
- **IP detection edge cases** (severity: low)
  - **Mitigation:** Filter virtual/VPN interfaces and allow `THUNK_HOST` override.

## Alternatives Considered

- **Add `thunk server` command**: Rejected by default to avoid extra CLI surface; can add if desired (Q5).
- **Textarea-based editor**: Rejected because Monaco is explicitly required.
- **Framework server (Express/Fastify)**: Rejected because Bun.serve is sufficient and keeps deps minimal.
