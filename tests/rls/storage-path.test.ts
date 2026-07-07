// SLICE-004 Storage-path check (§20.4 "plus a Storage-path check"; §7 [FIXED]
// `ws/{workspace_id}/…`). Storage objects are served via the service role,
// which bypasses RLS (F13), so tenant isolation for objects is the path
// prefix: a workspace-A actor asking for a workspace-B path must be denied,
// and no crafted path may parse into a foreign workspace.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildStoragePath,
  storagePathBelongsTo,
  storagePathWorkspaceId,
} from "@core/db/storage-path";

const workspaceA = randomUUID();
const workspaceB = randomUUID();

describe("storage path construction (§7)", () => {
  it("builds ws/{workspace_id}/… and round-trips to the owning workspace", () => {
    const path = buildStoragePath(workspaceA, ["proofs", "photo.jpg"]);
    expect(path).toBe(`ws/${workspaceA}/proofs/photo.jpg`);
    expect(storagePathWorkspaceId(path)).toBe(workspaceA);
    expect(storagePathBelongsTo(path, workspaceA)).toBe(true);
  });

  it("rejects paths that could escape or alias the tenant prefix at build time", () => {
    expect(() => buildStoragePath(workspaceA, [])).toThrow();
    expect(() => buildStoragePath(workspaceA, [""])).toThrow();
    expect(() => buildStoragePath(workspaceA, ["."])).toThrow();
    expect(() => buildStoragePath(workspaceA, [".."])).toThrow();
    expect(() => buildStoragePath(workspaceA, ["a/b"])).toThrow();
    expect(() => buildStoragePath("not-a-uuid", ["x"])).toThrow();
    // Non-canonical id spellings must not create a second prefix for the
    // same workspace.
    expect(() => buildStoragePath(workspaceA.toUpperCase(), ["x"])).toThrow();
  });
});

describe("workspace-A actor on workspace-B paths → denial (§20.4)", () => {
  it("a workspace-B object path never authorizes under workspace A", () => {
    const bPath = buildStoragePath(workspaceB, ["reports", "2026-07.json"]);
    expect(storagePathBelongsTo(bPath, workspaceA)).toBe(false);
    expect(storagePathBelongsTo(bPath, workspaceB)).toBe(true);
  });

  it("crafted paths fail closed instead of resolving to a workspace", () => {
    const crafted = [
      "", // empty
      `ws/${workspaceB}`, // bare tenant root, no object
      `ws/${workspaceB}/`, // trailing empty segment
      `/ws/${workspaceB}/x`, // absolute-style leading slash
      `xs/${workspaceB}/x`, // wrong prefix
      `ws/${workspaceB.toUpperCase()}/x`, // non-canonical id spelling
      `ws/${workspaceB}extra/x`, // id prefix-confusion
      `ws/not-a-uuid/x`, // non-uuid tenant segment
      `ws/${workspaceA}/../${workspaceB}/x`, // traversal out of tenant A
      `ws/${workspaceB}/./x`, // dot segment
      `ws/${workspaceB}//x`, // empty inner segment
    ];
    for (const path of crafted) {
      expect(storagePathWorkspaceId(path), path).toBeNull();
      expect(storagePathBelongsTo(path, workspaceA), path).toBe(false);
      expect(storagePathBelongsTo(path, workspaceB), path).toBe(false);
    }
  });

  it("a traversal path built from inside tenant A cannot reach tenant B", () => {
    expect(() => buildStoragePath(workspaceA, ["..", workspaceB, "file"])).toThrow();
  });
});
