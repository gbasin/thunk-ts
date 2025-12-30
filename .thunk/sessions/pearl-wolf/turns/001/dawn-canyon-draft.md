# Planning Task (Turn 1)

## Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | Bun's built-in capabilities suffice for daemon forking | Bun supports `Bun.spawn()` with detached processes; Node's `fork()` isn't needed |
| A2 | Monaco's ESM bundle works with Bun bundler | SPEC says "Bun bundler handles Monaco (no workers, basic highlighting)" |
| A3 | `clipboardy` works in Bun runtime | It's a pure JS package with native bindings; should work |
| A4 | Session tokens are short random strings (not UUIDs) | SPEC shows `?t=abc123` — 6-char alphanumeric seems reasonable |
| A5 | Server discovery uses PID check (not port probe) | `server.json` contains PID; we'll verify process is alive via `process.kill(pid, 0)` |
| A6 | Draft auto-save doesn't need websockets | Simple polling or fetch-based save is sufficient for 2s debounce |
| A7 | "Save & Continue" triggers CLI subprocess from server | Server shells out to `thunk continue && thunk wait`; user watches terminal for progress |

---

## Questions

**Q1: Should the web server be a separate entry point (`src/server/index.ts`) or integrated into the main CLI?**
- Context: The server runs as a daemon, but also needs to be startable for dev/testing
- My lean: Separate entry point (`src/server.ts` or `src/server/main.ts`) that can be run directly (`bun run src/server.ts`) or spawned by CLI
- **Answer:**

**Q2: How should we handle the "Save & Continue" long-running operation in the browser?**
- Context: When user clicks "Save & Continue", the server triggers `thunk continue && thunk wait` which can take minutes
- My lean: Server responds immediately with "started" status, browser shows spinner, then polls `/api/status/{session}` until phase changes. Alternatively, SSE/websocket for push updates
- **Answer:**

**Q3: Should Lit web components be compiled or shipped as ESM?**
- Context: SPEC mentions Lit but Bun bundler works differently than Vite/Rollup
- My lean: Bundle everything (Lit + Monaco + app code) into single `editor.js` and `list.js` files for simplicity
- **Answer:**

**Q4: Token generation strategy — crypto.randomUUID() or custom alphanumeric?**
- Context: SPEC shows short tokens like `abc123` in examples but doesn't specify length
- My lean: Use 16-char base64url tokens (secure, URL-safe, reasonably short)
- **Answer:**

---

## Notes for Agents

<!-- This is a significant feature with multiple moving parts. Recommend implementing in phases:
1. Server infrastructure (daemon, routing, auth)
2. CLI integration (thunk wait changes)
3. Web UI (editor page)
4. Advanced features (draft auto-save, continue flow)
-->

---

## Summary

Implement a web-based Monaco markdown editor for thunk planning sessions. The server runs as a detached daemon process, auto-starting when `thunk wait` completes. It provides authenticated endpoints for editing turn files, with per-session tokens for edit access and a global token for the session list. The CLI is modified to start the server, generate tokens, construct URLs, and copy them to clipboard.

The implementation follows a layered approach: server infrastructure first (daemon management, routing, auth), then CLI integration, then the web UI components (Monaco editor, session list), and finally advanced features (auto-save drafts, staleness detection, Save & Continue flow).

---

## Tasks

### Phase 1: Server Infrastructure

- [ ] **Task 1**: Create server daemon management module
  - **Files:** `src/server/daemon.ts` (create)
  - **Rationale:** Core infrastructure for starting/stopping detached server process
  - **Dependencies:** none
  - **Details:**
    - `startDaemon(thunkDir: string): Promise<{ pid: number, port: number }>`
    - `stopDaemon(thunkDir: string): Promise<boolean>`
    - `isDaemonRunning(thunkDir: string): Promise<{ running: boolean, port?: number }>`
    - Read/write `.thunk/server.json` for PID tracking
    - Fork process using `Bun.spawn()` with `detached: true`
    - Auto-find available port (3456, 3457, ...)
    - Log to `.thunk/server.log`

- [ ] **Task 2**: Create authentication module
  - **Files:** `src/server/auth.ts` (create)
  - **Rationale:** Token generation and validation for both session and global auth
  - **Dependencies:** none
  - **Details:**
    - `generateToken(): string` — 16-char base64url
    - `validateSessionToken(sessionId: string, token: string, manager: SessionManager): Promise<boolean>`
    - `validateGlobalToken(token: string, thunkDir: string): Promise<boolean>`
    - `ensureGlobalToken(thunkDir: string): Promise<string>` — creates `.thunk/token` if missing
    - `ensureSessionToken(sessionId: string, manager: SessionManager): Promise<string>` — adds to state.yaml if missing

- [ ] **Task 3**: Extend SessionState model for session tokens
  - **Files:** `src/models.ts` (modify)
  - **Rationale:** Session tokens need to persist in state.yaml
  - **Dependencies:** Task 2
  - **Details:**
    - Add optional `sessionToken?: string` field to SessionState
    - Update `toDict()` to serialize as `session_token`
    - Update constructor to accept `sessionToken` param

- [ ] **Task 4**: Extend SessionManager for token persistence
  - **Files:** `src/session.ts` (modify)
  - **Rationale:** Load/save session tokens from state.yaml
  - **Dependencies:** Task 3
  - **Details:**
    - Update `loadSession()` to read `session_token` from state.yaml
    - Update `saveState()` to write `session_token` if present
    - Add `ensureSessionToken(sessionId: string): Promise<string>` method

- [ ] **Task 5**: Create HTTP server with routing
  - **Files:** `src/server/index.ts` (create)
  - **Rationale:** Main server entry point using Bun.serve()
  - **Dependencies:** Task 2
  - **Details:**
    - `Bun.serve()` with fetch handler
    - Route matching: `/edit/:session`, `/list`, `/api/content/:session`, `/api/save/:session`, `/api/continue/:session`, `/assets/*`
    - Parse query params for token (`?t=`)
    - Pass `thunkDir` to handlers (walk up tree to find `.thunk`)
    - Idle timeout tracking (24h)
    - Pending session check on each request + hourly interval

- [ ] **Task 6**: Create route handlers
  - **Files:** `src/server/handlers.ts` (create)
  - **Rationale:** Separate handler logic from routing
  - **Dependencies:** Task 5, Task 4
  - **Details:**
    - `handleEdit(sessionId, token, manager): Response` — serve HTML editor page
    - `handleList(token, manager): Response` — serve HTML session list
    - `handleGetContent(sessionId, token, manager): Response` — JSON `{ content, mtime, turn, phase }`
    - `handleSave(sessionId, token, body, manager): Response` — save to turn file
    - `handleContinue(sessionId, token, body, manager): Response` — save + trigger continue
    - `handleAssets(path): Response` — static file serving
    - Error responses: 401/404/409/423 as specified

- [ ] **Task 7**: Create IP detection utility
  - **Files:** `src/server/network.ts` (create)
  - **Rationale:** Auto-detect local network IP for URL generation
  - **Dependencies:** none
  - **Details:**
    - `getLocalIP(): string` — returns primary IP (prefer en0/eth0)
    - Filter Docker, VPN interfaces (docker0, veth*, utun*, tun*)
    - Check `THUNK_HOST` env var override
    - Fallback to `localhost`

### Phase 2: CLI Integration

- [ ] **Task 8**: Modify `thunk wait` to start server and output URL
  - **Files:** `src/cli.ts` (modify)
  - **Rationale:** Main integration point per SPEC
  - **Dependencies:** Task 1, Task 4, Task 7
  - **Details:**
    - Check `THUNK_WEB` env var (default enabled, `0` to disable)
    - After successful turn completion:
      1. Call `isDaemonRunning()` — if not, call `startDaemon()`
      2. Call `ensureSessionToken(sessionId)`
      3. Get local IP via `getLocalIP()`
      4. Construct URL: `http://{ip}:{port}/edit/{sessionId}?t={token}`
      5. Copy to clipboard via `clipboardy`
      6. Add `edit_url` to JSON output
    - Handle clipboard errors gracefully (log warning, don't fail)

- [ ] **Task 9**: Add `thunk server` command for manual control
  - **Files:** `src/cli.ts` (modify)
  - **Rationale:** Useful for development and debugging
  - **Dependencies:** Task 1, Task 5
  - **Details:**
    - `thunk server start` — start daemon
    - `thunk server stop` — stop daemon
    - `thunk server status` — check if running, show port/URL
    - Optional `--foreground` flag to run in foreground (for dev)

### Phase 3: Web UI

- [ ] **Task 10**: Create web build configuration
  - **Files:** `src/web/build.ts` (create), `package.json` (modify)
  - **Rationale:** Bundle Monaco + Lit + app code for browser
  - **Dependencies:** none
  - **Details:**
    - Bun bundler config for `src/web/editor.ts` → `dist/web/editor.js`
    - Bun bundler config for `src/web/list.ts` → `dist/web/list.js`
    - Copy static assets (CSS, HTML templates)
    - Add `build:web` script to package.json
    - Monaco config: no workers, language=markdown only

- [ ] **Task 11**: Create editor HTML template
  - **Files:** `src/web/index.html` (create)
  - **Rationale:** Shell page for Monaco editor
  - **Dependencies:** none
  - **Details:**
    - Minimal header: session name, turn number
    - Full-height editor container
    - Footer with Save/Save & Continue buttons
    - Dark mode via `prefers-color-scheme`
    - Load `editor.js` bundle
    - Inject session ID and token as data attributes or inline script

- [ ] **Task 12**: Create editor Lit component
  - **Files:** `src/web/editor.ts` (create)
  - **Rationale:** Monaco integration with save/continue logic
  - **Dependencies:** Task 11
  - **Details:**
    - Initialize Monaco with markdown config
    - Word wrap, line numbers, minimap, bracket matching
    - Theme: `vs` or `vs-dark` based on system preference
    - Keyboard shortcuts: Cmd/Ctrl+S (save), Cmd/Ctrl+Enter (continue)
    - `beforeunload` warning for unsaved changes
    - Fetch content from `/api/content/:session?t=...`
    - POST to `/api/save/:session?t=...` on save
    - Display mtime staleness warning

- [ ] **Task 13**: Create session list HTML template
  - **Files:** `src/web/list.html` (create)
  - **Rationale:** Overview page for all sessions
  - **Dependencies:** none
  - **Details:**
    - Simple table/list layout
    - Columns: session name, task (truncated), turn, phase, edit link
    - Edit link only for `user_review` phase sessions
    - Dark mode support

- [ ] **Task 14**: Create session list component
  - **Files:** `src/web/list.ts` (create)
  - **Rationale:** Fetch and render session list
  - **Dependencies:** Task 13
  - **Details:**
    - Fetch session list from server (via internal API or embedded data)
    - Render table with session info
    - Generate edit URLs with per-session tokens
    - Show "Approved" badge for completed sessions

- [ ] **Task 15**: Create shared styles
  - **Files:** `src/web/styles.css` (create)
  - **Rationale:** Consistent styling across pages
  - **Dependencies:** none
  - **Details:**
    - CSS variables for colors (light/dark)
    - Header, footer, button styles
    - Responsive layout
    - Monaco container sizing

### Phase 4: Advanced Features

- [ ] **Task 16**: Implement draft auto-save
  - **Files:** `src/web/editor.ts` (modify), `src/server/handlers.ts` (modify)
  - **Rationale:** Backup edits to prevent data loss
  - **Dependencies:** Task 12, Task 6
  - **Details:**
    - Debounce editor changes (~2 seconds)
    - POST to `/api/draft/:session?t=...` with content
    - Server writes to `{turn}-draft.md`
    - On explicit save, delete draft file
    - On load, check for draft and show recovery option

- [ ] **Task 17**: Implement staleness detection
  - **Files:** `src/web/editor.ts` (modify), `src/server/handlers.ts` (modify)
  - **Rationale:** Prevent overwriting external changes
  - **Dependencies:** Task 12
  - **Details:**
    - `/api/content` returns mtime
    - Editor stores mtime on load
    - `/api/save` accepts expected mtime, returns 409 if changed
    - Editor shows error dialog with reload option

- [ ] **Task 18**: Implement Save & Continue flow
  - **Files:** `src/server/handlers.ts` (modify), `src/web/editor.ts` (modify)
  - **Rationale:** Trigger next turn from web UI
  - **Dependencies:** Task 6, Task 12
  - **Details:**
    - `/api/continue` saves content, then shells out to `thunk continue && thunk wait`
    - Return immediately with `{ status: "started" }`
    - Editor shows spinner, polls `/api/status/:session` for completion
    - When phase returns to `user_review`, reload content

- [ ] **Task 19**: Implement idle shutdown
  - **Files:** `src/server/index.ts` (modify)
  - **Rationale:** Clean up server when not in use
  - **Dependencies:** Task 5
  - **Details:**
    - Track last save operation timestamp
    - Hourly check: if 24h since last save AND no sessions in `user_review` phase, shutdown
    - Graceful shutdown: close connections, remove `server.json`

- [ ] **Task 20**: Implement read-only mode for approved sessions
  - **Files:** `src/server/handlers.ts` (modify), `src/web/editor.ts` (modify)
  - **Rationale:** Prevent edits to finalized plans
  - **Dependencies:** Task 6, Task 12
  - **Details:**
    - Check session phase in `/api/content` response
    - If `approved`, set `readOnly: true` in response
    - Editor disables Monaco editing, hides save buttons
    - Show "Approved" badge in header

### Phase 5: Testing & Polish

- [ ] **Task 21**: Add server unit tests
  - **Files:** `tests/server.test.ts` (create)
  - **Rationale:** Test daemon, auth, handlers in isolation
  - **Dependencies:** Tasks 1-7
  - **Details:**
    - Test token generation/validation
    - Test daemon start/stop/status
    - Test route matching
    - Mock file system for handler tests

- [ ] **Task 22**: Add integration tests
  - **Files:** `tests/integration.test.ts` (create)
  - **Rationale:** End-to-end flow testing
  - **Dependencies:** Tasks 8-9
  - **Details:**
    - Test `thunk wait` → server starts → URL generated
    - Test save/load via API
    - Test `thunk server` commands

- [ ] **Task 23**: Add dependencies to package.json
  - **Files:** `package.json` (modify)
  - **Rationale:** New runtime dependencies
  - **Dependencies:** none
  - **Details:**
    - Add `clipboardy` (runtime)
    - Add `monaco-editor` (dev, bundled)
    - Add `lit` (dev, bundled)

- [ ] **Task 24**: Update documentation
  - **Files:** `README.md` (modify)
  - **Rationale:** Document new web editor feature
  - **Dependencies:** All above
  - **Details:**
    - Add Web Editor section
    - Document `THUNK_WEB` env var
    - Document `thunk server` commands
    - Add troubleshooting for network/firewall issues

---

## Risks

- **Monaco bundle size** (severity: medium)
  - Monaco is ~1MB minified; may slow npm install and increase package size
  - **Mitigation:** Use Monaco's ESM build with only markdown language, lazy-load on first editor open

- **Bun daemon detachment quirks** (severity: medium)
  - Bun's `Bun.spawn()` detachment may behave differently than Node's `fork()`
  - **Mitigation:** Test on macOS/Linux early; have fallback to `nohup` or similar

- **Clipboard access on headless/SSH** (severity: low)
  - `clipboardy` may fail on headless servers or SSH sessions
  - **Mitigation:** Catch errors, still print URL to console, warn user

- **Port conflicts** (severity: low)
  - Port 3456 may be in use by other software
  - **Mitigation:** Auto-increment port (3457, 3458...) as specified in SPEC

- **Cross-platform network detection** (severity: low)
  - Different interface names on Linux vs macOS
  - **Mitigation:** Use `os.networkInterfaces()` with filtering, allow `THUNK_HOST` override

---

## Alternatives Considered

- **WebSocket for real-time sync**: Rejected because auto-save with polling is simpler and sufficient for single-user editing

- **Separate npm package for server**: Rejected because tight integration with thunk CLI is needed; single package is simpler

- **CodeMirror instead of Monaco**: Rejected because Monaco has better TypeScript support and is more familiar to VS Code users

- **Express/Fastify framework**: Rejected because Bun.serve() is simpler and has no dependencies; routing is minimal

- **localStorage for drafts**: Rejected because server is source of truth; localStorage would create sync issues with multiple devices
