import { describe, expect, it } from "vitest";

import { localSupabaseUrl } from "../db/dev-bootstrap";

describe("FIX-040 dev bootstrap Supabase environment guard", () => {
  it.each(["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"])(
    "accepts local URL %s",
    (value) => {
      expect(localSupabaseUrl(value).hostname).toBeDefined();
    },
  );

  it.each(["https://project.supabase.co", "https://localhost.example.test", "http://10.0.0.1:54321", "not a URL"])(
    "refuses non-local URL %s",
    (value) => {
      expect(() => localSupabaseUrl(value)).toThrow();
    },
  );
});
