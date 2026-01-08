import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

import type { SessionManager } from "../session";

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function generateToken(): string {
  return crypto.randomBytes(12).toString("base64url");
}

async function readToken(tokenPath: string): Promise<string | null> {
  try {
    const existing = (await fs.readFile(tokenPath, "utf8")).trim();
    return existing || null;
  } catch {
    return null;
  }
}

export async function ensureGlobalToken(
  globalDir: string,
  legacyPl4nDir?: string,
): Promise<string> {
  const tokenPath = path.join(globalDir, "token");
  try {
    const existing = await readToken(tokenPath);
    if (existing) {
      return existing;
    }
  } catch {}

  if (legacyPl4nDir) {
    const legacyPath = path.join(legacyPl4nDir, "token");
    const legacyToken = await readToken(legacyPath);
    if (legacyToken) {
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(tokenPath, `${legacyToken}\n`, "utf8");
      return legacyToken;
    }
  }

  const token = generateToken();
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(tokenPath, `${token}\n`, "utf8");
  return token;
}

export async function validateGlobalToken(
  token: string | null,
  globalDir: string,
): Promise<boolean> {
  if (!token) {
    return false;
  }
  const tokenPath = path.join(globalDir, "token");
  try {
    const stored = (await fs.readFile(tokenPath, "utf8")).trim();
    return timingSafeEqual(token, stored);
  } catch {
    return false;
  }
}

export async function validateSessionToken(
  sessionId: string,
  token: string | null,
  manager: SessionManager,
): Promise<boolean> {
  if (!token) {
    return false;
  }
  const session = await manager.loadSession(sessionId);
  if (!session || !session.sessionToken) {
    return false;
  }
  return timingSafeEqual(token, session.sessionToken);
}
