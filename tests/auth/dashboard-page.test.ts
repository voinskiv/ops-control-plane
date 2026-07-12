import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  forbidden: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
  }),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ toString: () => "session=cookie" }) }));
vi.mock("next/navigation", () => ({ forbidden: mocks.forbidden, redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    values?.code === undefined ? key : `${key}:${values.code}`,
}));
vi.mock("@core/auth/runtime", () => ({
  getDashboardAuth: () => ({
    currentSession: async () => ({
      actor: { type: "person", id: "00000000-0000-4000-8000-000000000001", roleClass: "supervisor", workspaceId: "00000000-0000-4000-8000-000000000002" },
      membership: {
        person_id: "00000000-0000-4000-8000-000000000001",
        workspace_id: "00000000-0000-4000-8000-000000000002",
        workspace_display_name: "Test",
        role_class: "supervisor",
        locale: "de",
      },
    }),
  }),
}));

import DashboardForbidden from "../../app/(dashboard)/dashboard/forbidden";
import DashboardPage from "../../app/(dashboard)/dashboard/page";

describe("/dashboard supervisor rejection (DEC-014 item 2)", () => {
  it("invokes Next's HTTP 403 boundary after per-request supervisor resolution", async () => {
    await expect(DashboardPage()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;403");
    expect(mocks.forbidden).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("renders the catalog rejection and typed unauthorized code", async () => {
    const html = renderToStaticMarkup(await DashboardForbidden());
    expect(html).toContain("errors.action.unauthorized");
    expect(html).toContain("auth.forbidden.code:unauthorized");
  });
});
