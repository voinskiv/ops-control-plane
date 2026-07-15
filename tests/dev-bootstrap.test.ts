import { describe, expect, it } from "vitest";

import { localUrl } from "../db/dev-bootstrap";

describe("FIX-040 dev bootstrap environment guards", () => {
  it.each(["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"])(
    "accepts local SUPABASE_URL %s",
    (value) => {
      expect(localUrl("SUPABASE_URL", value).hostname).toBeDefined();
    },
  );

  it.each(["https://project.supabase.co", "https://localhost.example.test", "http://10.0.0.1:54321", "not a URL"])(
    "refuses non-local SUPABASE_URL %s",
    (value) => {
      expect(() => localUrl("SUPABASE_URL", value)).toThrow("SUPABASE_URL");
    },
  );

  it.each([
    "postgresql://postgres:postgres@localhost:54322/postgres",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgresql://postgres:postgres@[::1]:54322/postgres",
  ])("accepts local DATABASE_URL %s", (value) => {
    expect(localUrl("DATABASE_URL", value).hostname).toBeDefined();
  });

  it.each(["postgresql://postgres:postgres@db.example.test:5432/postgres", "not a URL"])(
    "refuses non-local DATABASE_URL %s",
    (value) => {
      expect(() => localUrl("DATABASE_URL", value)).toThrow("DATABASE_URL");
    },
  );
});
