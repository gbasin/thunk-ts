import { describe, expect, it } from "bun:test";
import { createProjectId } from "../src/server/project-id";

describe("project id", () => {
  it("creates stable slug-hash ids", () => {
    const id = createProjectId("/Users/me/Work/Project Alpha");
    const second = createProjectId("/Users/me/Work/Project Alpha");
    expect(id).toBe(second);
    expect(id).toContain("--");
    const [slug, hash] = id.split("--");
    expect(slug).toBe("project-alpha");
    expect(hash.length).toBe(6);
  });
});
