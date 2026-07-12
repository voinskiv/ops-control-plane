import type { RoleClass } from "../actions/types";

export const DASHBOARD_REJECTION_CODE = "unauthorized" as const;
export const DASHBOARD_ROUTE = "/dashboard" as const;
export const CAPTURE_ROUTE = "/capture" as const;

export function landingRoute(roleClass: RoleClass): typeof DASHBOARD_ROUTE | typeof CAPTURE_ROUTE {
  return roleClass === "supervisor" ? CAPTURE_ROUTE : DASHBOARD_ROUTE;
}

export function dashboardAccess(roleClass: RoleClass):
  | { allowed: true; status: 200 }
  | { allowed: false; status: 403; code: typeof DASHBOARD_REJECTION_CODE } {
  return roleClass === "owner" || roleClass === "manager"
    ? { allowed: true, status: 200 }
    : { allowed: false, status: 403, code: DASHBOARD_REJECTION_CODE };
}

export function captureAllowed(roleClass: RoleClass): boolean {
  return roleClass === "owner" || roleClass === "manager" || roleClass === "supervisor";
}
