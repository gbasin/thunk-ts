# Web Editor — Unified Implementation Plan

## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | `thunk wait` emits `edit_url` whenever returning `phase: user_review`, even if already in that phase | Ensures users always get a URL; matches "auto-starts when thunk wait completes" |
| A2 | Per-session tokens generated lazily on first access, not at session creation | Backward-compatible with existing sessions; simpler than migrating old sessions |
| A3 | Draft auto-save operations count as "activity" for the 24-hour idle timer | Prevents daemon shutdown mid-edit |
| A4 | Server prefers `dist/web/` assets, falls back to `src/web/` in dev | Enables dev workflow without build step |
| A5 | Bun's `Bun.spawn()` with `detached: true` suffices for daemon forking | Simpler than Node's fork(); can fallback to nohup if needed |
| A6 | Clipboard failures are non-fatal; URL still printed to console | Graceful degradation for headless/SSH environments |
| A7 | Server inherits thunk-dir from CLI via `THUNK_DIR` environment variable | Ensures consistency when non-default directory is used |
| A8 | 16-char base64url tokens provide sufficient entropy without being unwieldy | Balance between URL friendliness and security |

### Questions

**Q1: Should `Save & Continue` block the HTTP request until `thunk wait` finishes, or return immediately?**
- Context: Blocking could hold requests for minutes and complicate server timeouts; returning early matches "user monitors progress in terminal."
- My lean: Return 202 immediately after starting `thunk continue`, then poll `/api/status/{session}` until phase changes back to `user_review`. This keeps HTTP simple and lets the browser show a progress indicator.
- **Answer:**

**Q2: Should we add a separate `/api/draft/{session}` endpoint, or overload `/api/save` with a mode flag?**
- Context: SPEC only lists `/api/save`. Draft auto-save has different semantics (no mtime check, no draft cleanup).
- My lean: Add `/api/draft` endpoint for clarity—explicit separation of commit vs auto-save operations.
- **Answer:**

**Q3: For draft recovery "view diff," should we show a true inline diff or simpler side-by-side?**
- Context: True diff requires extra browser code; side-by-side is lighter but less informative.
- My lean: Use the existing `diff` package (already a dependency) to render an inline diff in a modal. Keeps things lightweight and consistent with server-side diff logic.
- **Answer:**

**Q4: Do you want an explicit `thunk server` command for manual start/stop/status, or keep server management fully implicit?**
- Context: Helpful for dev/debugging, but not strictly required by the spec.
- My lean: Add `thunk server start|stop|status` for dev convenience. Minimal extra surface; aids troubleshooting.
- **Answer:**

---

## Notes for Agents

- Keep new files under 500 LOC; split utilities if needed.
- Run `bun run lint && bun run test` after each batch of changes.
- Tests should avoid spawning real daemons; mock `Bun.spawn()` or use foreground mode.
- Server and CLI share session/auth code—avoid duplication by importing from shared modules.
- Web assets are bundled separately via `build:web`; CI only.

---

## Summary

Add a Bun-based daemon web server that serves a Monaco/Lit markdown editor for thunk planning sessions. The server auto-starts when `thunk wait` completes (unless `THUNK_WEB=0`), provides per-session authenticated editing via URL tokens, and includes draft auto-save with recovery. The CLI is modified to output `edit_url` in JSON and copy it to clipboard. Asset bundling via `bun run build:web` outputs to `dist/web/`, with dev fallback to source files.

---

## Tasks

### Phase 1: Token & Auth Infrastructure

- [ ] **Task 1**: Add session token support to models and session manager
  - **Files:** `src/models.ts` (modify), `src/session.ts` (modify)
  - **Rationale:** Tokens must persist in `state.yaml`; lazy generation handles existing sessions
  - **Dependencies:** none
  - **Details:**
    - Add optional `sessionToken?: string` to `SessionState`
    - Update `toDict()` to serialize as `session_token`
    - Update `loadSession()` to read `session_token` from state.yaml
    - Update `saveState()` to write `session_token` if present
    - Add `ensureSessionToken(sessionId): Promise<string>` to `SessionManager`—generates if missing, saves, returns

- [ ] **Task 2**: Create authentication module
  - **Files:** `src/server/auth.ts` (create)
  - **Rationale:** Centralize token generation and validation logic
  - **Dependencies:** Task 1
  - **Details:**
    - `generateToken(): string` — 16-char base64url via `crypto.randomBytes(12).toString('base64url')`
    - `validateSessionToken(sessionId, token, manager): Promise<boolean>` — timing-safe comparison
    - `validateGlobalToken(token, thunkDir): Promise<boolean>`
    - `ensureGlobalToken(thunkDir): Promise<string>` — creates `.thunk/token` if missing

### Phase 2: Server Infrastructure

- [ ] **Task 3**: Create network utilities
  - **Files:** `src/server/network.ts` (create)
  - **Rationale:** IP detection and port finding for URL construction
  - **Dependencies:** none
  - **Details:**
    - `getLocalIP(): string` — prefer en0/eth0, filter docker/VPN interfaces via `os.networkInterfaces()`
    - `findAvailablePort(start: number): Promise<number>` — try 3456, 3457, etc.
    - Check `THUNK_HOST` env var override
    - Fallback to `localhost` if no suitable interface found

- [ ] **Task 4**: Create daemon lifecycle management
  - **Files:** `src/server/daemon.ts` (create)
  - **Rationale:** Start/stop detached server process with PID tracking
  - **Dependencies:** Task 3
  - **Details:**
    - `startDaemon(thunkDir): Promise<{ pid: number, port: number }>` — spawn detached via `Bun.spawn()`
    - `stopDaemon(thunkDir): Promise<boolean>` — send SIGTERM, clean up `server.json`
    - `isDaemonRunning(thunkDir): Promise<{ running: boolean, port?: number, pid?: number }>` — validate PID with `process.kill(pid, 0)`
    - Read/write `.thunk/server.json` with `{ pid, port, started_at, last_activity }`
    - Remove stale `server.json` if PID is dead
    - Pass `THUNK_DIR` env var to spawned process
    - Log to `.thunk/server.log` (append mode)

- [ ] **Task 5**: Create HTTP server and route handlers
  - **Files:** `src/server/index.ts` (create), `src/server/handlers.ts` (create)
  - **Rationale:** Main server entry point using Bun.serve() with route handlers
  - **Dependencies:** Tasks 2, 3, 4
  - **Details:**
    - `Bun.serve()` binding to `0.0.0.0:{port}`
    - Route matching via path parsing (no framework)
    - Routes: `/edit/:session`, `/list`, `/api/content/:session`, `/api/save/:session`, `/api/draft/:session`, `/api/continue/:session`, `/api/status/:session`, `/assets/*`
    - Query param parsing for `?t={token}`
    - Read `THUNK_DIR` env or walk up tree to find `.thunk`
    - Track `last_activity` timestamp on save/draft operations
    - Hourly idle check: shutdown if 24h inactive AND no `user_review` sessions
    - Graceful shutdown: close server, remove `server.json`
    - **Error responses:** 401 (bad token), 404 (no session), 409 (stale mtime), 423 (approved/locked)

### Phase 3: CLI Integration

- [ ] **Task 6**: Modify `thunk wait` for web server integration
  - **Files:** `src/cli.ts` (modify), `package.json` (modify)
  - **Rationale:** Auto-start server and emit `edit_url` when phase is `user_review`
  - **Dependencies:** Tasks 1, 3, 4
  - **Details:**
    - Check `THUNK_WEB` env var (default enabled, `0` to disable)
    - When returning `phase: user_review` (both after turn completion AND when already in that phase):
      1. Call `isDaemonRunning()` — if not running, call `startDaemon()`
      2. Call `manager.ensureSessionToken(sessionId)`
      3. Get local IP via `getLocalIP()`
      4. Construct URL: `http://{ip}:{port}/edit/{sessionId}?t={token}`
      5. Try clipboard copy via `clipboardy`; catch and warn on failure
      6. Add `edit_url` field to JSON output
    - Add `clipboardy` as runtime dependency

- [ ] **Task 7**: Add `thunk server` command
  - **Files:** `src/cli.ts` (modify)
  - **Rationale:** Manual server control for development and debugging
  - **Dependencies:** Tasks 3, 4
  - **Details:**
    - `thunk server start` — start daemon, output port/URL
    - `thunk server stop` — stop daemon
    - `thunk server status` — check if running, show port/PID/URL
    - `thunk server start --foreground` — run in foreground (for dev/debugging)
    - Respect `--thunk-dir` global option

### Phase 4: Web UI

- [ ] **Task 8**: Create web build pipeline
  - **Files:** `src/web/build.ts` (create), `package.json` (modify)
  - **Rationale:** Bundle Monaco + Lit + app code for browser
  - **Dependencies:** none
  - **Details:**
    - Bun bundler config: `src/web/editor.ts` → `dist/web/editor.js`
    - Bun bundler config: `src/web/list.ts` → `dist/web/list.js`
    - Copy `src/web/*.html`, `src/web/styles.css` to `dist/web/`
    - Monaco config: disable workers, markdown language only
    - Add `build:web` script to package.json
    - Add `monaco-editor`, `lit` as dev dependencies

- [ ] **Task 9**: Create editor page
  - **Files:** `src/web/index.html` (create), `src/web/editor.ts` (create), `src/web/styles.css` (create)
  - **Rationale:** Monaco-based markdown editor with save/continue functionality
  - **Dependencies:** Task 8
  - **Details:**
    - **HTML template:**
      - Header: session name, "Turn N", optional "Approved" badge
      - Full-height Monaco container
      - Footer: Save button, Save & Continue button
      - Dark mode via `prefers-color-scheme`
      - Inject `data-session`, `data-token` attributes
    - **Lit component (`<thunk-editor>`):**
      - Initialize Monaco: markdown, word wrap, line numbers, minimap
      - Theme: `vs` / `vs-dark` based on `matchMedia('(prefers-color-scheme: dark)')`
      - Keyboard shortcuts: Cmd/Ctrl+S (save), Cmd/Ctrl+Enter (continue), Esc (close)
      - Fetch content from `/api/content/:session?t=...` on mount
      - Track `mtime` from response; show staleness error on 409
      - `beforeunload` warning for unsaved changes
      - **Draft auto-save:** debounce 2s, POST to `/api/draft/:session?t=...`
      - **Draft recovery:** if `hasDraft` in content response, show banner with "View diff" / "Restore" / "Discard"
      - **Diff modal:** render inline diff using existing `diff` package logic
      - Save: POST to `/api/save/:session?t=...` with content + expected mtime
      - Continue: POST to `/api/continue/:session?t=...`, show spinner, poll `/api/status/:session?t=...` until phase changes
    - **Read-only mode:** if `readOnly` in content response, disable editor, hide save buttons, show "Approved" badge
    - **Styles:**
      - CSS variables for light/dark themes
      - Full viewport height layout
      - Button styling, modal styling
      - Responsive (works on mobile Safari)

- [ ] **Task 10**: Create session list page
  - **Files:** `src/web/list.html` (create), `src/web/list.ts` (create)
  - **Rationale:** Overview of all sessions with edit links
  - **Dependencies:** Task 8
  - **Details:**
    - **HTML template:** Simple list/table layout with dark mode support
    - **Lit component (`<thunk-list>`):**
      - Fetch session list via internal API or embedded JSON
      - Render: session name, task (truncated ~80 chars), turn, phase, edit link
      - Edit link only for `user_review` phase (includes per-session token)
      - "Approved" badge for completed sessions
      - Sort by updated_at descending

### Phase 5: Testing & Documentation

- [ ] **Task 11**: Add token and auth tests
  - **Files:** `tests/session.test.ts` (modify), `tests/server.test.ts` (create)
  - **Rationale:** Ensure token persistence and validation work correctly
  - **Dependencies:** Tasks 1, 2
  - **Details:**
    - Test `SessionState` with `sessionToken` field serialization
    - Test `ensureSessionToken()` lazy generation and persistence
    - Test `generateToken()` format (16-char base64url)
    - Test `validateSessionToken()` / `validateGlobalToken()`
    - Test `ensureGlobalToken()` file creation

- [ ] **Task 12**: Add daemon and handler tests
  - **Files:** `tests/server.test.ts` (modify)
  - **Rationale:** Test server lifecycle without actually starting daemons
  - **Dependencies:** Tasks 4, 5
  - **Details:**
    - Mock `Bun.spawn()` for daemon tests
    - Test `isDaemonRunning()` with stale PID handling
    - Test `findAvailablePort()` logic
    - Test route matching and handler responses (200, 401, 404, 409, 423)
    - Test idle shutdown logic

- [ ] **Task 13**: Add CLI integration tests
  - **Files:** `tests/cli.test.ts` (modify)
  - **Rationale:** Verify `thunk wait` emits `edit_url` correctly
  - **Dependencies:** Tasks 6, 7
  - **Details:**
    - Mock daemon functions to avoid real server startup
    - Test `edit_url` in JSON output when phase is `user_review`
    - Test `THUNK_WEB=0` opt-out behavior
    - Test clipboard error handling (graceful degradation)
    - Test `thunk server` subcommands

- [ ] **Task 14**: Update documentation
  - **Files:** `README.md` (modify)
  - **Rationale:** Document new web editor feature and commands
  - **Dependencies:** All above
  - **Details:**
    - Add "Web Editor" section explaining the feature
    - Document `THUNK_WEB=0` opt-out
    - Document `thunk server` commands
    - Add troubleshooting: firewall, port conflicts, clipboard issues
    - Note `THUNK_HOST` override for IP detection

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Stale PID / zombie `server.json` | Medium | Validate PID with `process.kill(pid, 0)` in `isDaemonRunning()`; remove stale file |
| Monaco bundle size (~1MB) | Medium | Disable workers, include only markdown language, bundle once in CI |
| Bun daemon detachment quirks | Medium | Test on macOS/Linux early; fallback to `nohup` wrapper if needed |
| Long-running `Save & Continue` requests | Medium | Return 202 immediately, use polling for status updates |
| Clipboard failures in headless/SSH | Low | Catch errors, still print URL, warn user gracefully |
| Port conflicts on 3456 | Low | Auto-increment port (3457, 3458...) until available |
| Cross-platform IP detection differences | Low | Use `os.networkInterfaces()` with heuristics; allow `THUNK_HOST` override |

---

## Alternatives Considered

| Alternative | Rejected Because |
|-------------|------------------|
| WebSocket for real-time updates | Polling is simpler and sufficient for single-user editing with 2s debounce |
| Separate npm package for server | Tight CLI integration required; single package is simpler |
| CodeMirror instead of Monaco | Monaco has better markdown support and is familiar to VS Code users |
| Express/Hono framework | Bun.serve() is simpler with no dependencies; routing is minimal |
| localStorage for drafts | Server is source of truth; would cause sync issues with multi-device access |
| In-process server (no daemon) | Server must survive beyond `thunk wait` for mobile device access |
| Blocking `Save & Continue` HTTP request | Would timeout; returning 202 with polling is more robust |
