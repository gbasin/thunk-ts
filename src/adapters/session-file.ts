/**
 * Shared session/thread ID file utilities for agent adapters
 */
import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";

/**
 * Read a session/thread ID from a file asynchronously.
 */
export async function readSessionId(sessionFile?: string): Promise<string | null> {
  if (!sessionFile) {
    return null;
  }
  try {
    const content = await fs.readFile(sessionFile, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Read a session/thread ID from a file synchronously.
 */
export function readSessionIdSync(sessionFile?: string): string | null {
  if (!sessionFile) {
    return null;
  }
  try {
    const content = fsSync.readFileSync(sessionFile, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Write a session/thread ID to a file atomically.
 */
export async function writeSessionId(
  sessionFile: string | undefined,
  sessionId: string | null,
): Promise<void> {
  if (!sessionFile || !sessionId) {
    return;
  }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const tempFile = `${sessionFile}.tmp`;
  await fs.writeFile(tempFile, sessionId, "utf8");
  await fs.rename(tempFile, sessionFile);
}
