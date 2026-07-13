import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../../app/api/cron/commitments/complete/route";

const originalSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("commitment completion cron HTTP mount (§21.17)", () => {
  it("fails closed when CRON_SECRET is missing or the bearer does not match", async () => {
    delete process.env.CRON_SECRET;
    await expect(GET(new Request("http://localhost/api/cron/commitments/complete"))).resolves.toMatchObject({ status: 401 });
    process.env.CRON_SECRET = "test-cron-secret";
    await expect(
      GET(new Request("http://localhost/api/cron/commitments/complete", { headers: { authorization: "Bearer wrong" } })),
    ).resolves.toMatchObject({ status: 401 });
  });
});
