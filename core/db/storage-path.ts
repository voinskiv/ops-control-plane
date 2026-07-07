// §7 [FIXED]: Supabase Storage paths are prefixed `ws/{workspace_id}/…`.
// The service role that serves Storage bypasses RLS (F13), so object-level
// tenancy rests entirely on this prefix. Every Storage path is built and
// authorized through this module — later Storage writers (proof.attach,
// report.generate, doc.upload) must not assemble paths by hand — and parsing
// fails closed: anything non-canonical resolves to no workspace, which
// callers must treat as denial.
const PREFIX = "ws";

// Canonical lowercase text form of the app-generated UUIDs (§3). Uppercase or
// otherwise non-canonical ids are rejected rather than normalized: two
// spellings of one workspace id must never yield two distinct Storage
// prefixes.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." && !segment.includes("/");
}

export function buildStoragePath(workspaceId: string, segments: readonly string[]): string {
  if (!CANONICAL_UUID.test(workspaceId)) {
    throw new Error("storage path requires a canonical lowercase workspace uuid");
  }
  if (segments.length === 0) {
    throw new Error("storage path requires at least one object segment");
  }
  for (const segment of segments) {
    if (!isValidSegment(segment)) {
      throw new Error(`invalid storage path segment: ${JSON.stringify(segment)}`);
    }
  }
  return [PREFIX, workspaceId, ...segments].join("/");
}

// The owning workspace of a stored path, or null when the path is not a
// well-formed `ws/{workspace_id}/…` tenant path.
export function storagePathWorkspaceId(path: string): string | null {
  const segments = path.split("/");
  if (segments.length < 3 || segments[0] !== PREFIX) {
    return null;
  }
  const workspaceId = segments[1];
  if (workspaceId === undefined || !CANONICAL_UUID.test(workspaceId)) {
    return null;
  }
  for (const segment of segments.slice(2)) {
    if (!isValidSegment(segment)) {
      return null;
    }
  }
  return workspaceId;
}

// The single authorization question Storage access must ask (§20.4): does
// this path belong to the acting workspace?
export function storagePathBelongsTo(path: string, workspaceId: string): boolean {
  const owner = storagePathWorkspaceId(path);
  return owner !== null && owner === workspaceId;
}
