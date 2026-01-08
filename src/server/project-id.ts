import crypto from "crypto";
import path from "path";

function slugify(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "project";
}

export function projectSlug(projectRoot: string): string {
  return slugify(path.basename(projectRoot));
}

export function createProjectId(projectRoot: string): string {
  const hash = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 6);
  return `${projectSlug(projectRoot)}--${hash}`;
}
