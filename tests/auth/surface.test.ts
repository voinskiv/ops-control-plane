import { describe, expect, it } from "vitest";

import {
  CAPTURE_ROUTE,
  DASHBOARD_REJECTION_CODE,
  DASHBOARD_ROUTE,
  captureAllowed,
  dashboardAccess,
  landingRoute,
} from "@core/auth/surface";

describe("SLICE-009 auth surface routing (DEC-014 item 2)", () => {
  it("routes supervisors to /capture and represents /dashboard as a typed HTTP 403", () => {
    expect(landingRoute("supervisor")).toBe(CAPTURE_ROUTE);
    expect(dashboardAccess("supervisor")).toEqual({
      allowed: false,
      status: 403,
      code: DASHBOARD_REJECTION_CODE,
    });
  });

  it("routes owners/managers to /dashboard while retaining capture inheritance", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(landingRoute(role)).toBe(DASHBOARD_ROUTE);
      expect(dashboardAccess(role)).toEqual({ allowed: true, status: 200 });
      expect(captureAllowed(role)).toBe(true);
    }
  });
});
