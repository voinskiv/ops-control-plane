// SLICE-011 / ARCHITECTURE.md §19 / DEC-004: Demo GmbH is produced only by
// replaying registered kernel actions with deterministic idempotency keys.
import { noopUnlimitedResolver } from "../../core/actions/entitlement";
import { Kernel } from "../../core/actions/kernel";
import { registry } from "../../core/actions/registry";
import type { Actor, ResponseEnvelope } from "../../core/actions/types";
import { createKernelDb } from "../../core/db/kernel";

const KEY_PREFIX = "seed:demo-gmbh:phase0:v1";
const BOOTSTRAP_OWNER_ACTOR_ID = "00000000-0000-7000-8000-000000000011";

interface SeedIds {
  workspaceId: string;
  ownerId: string;
  managerId: string;
  supervisorIds: [string, string];
  workerIds: string[];
  clientIds: [string, string];
  siteIds: [string, string, string, string];
}

function resultId(envelope: ResponseEnvelope, field: string, action: string): string {
  if (envelope.status !== "ok") {
    throw new Error(`${action} failed with ${JSON.stringify(envelope)}`);
  }
  const result = envelope.result as Record<string, unknown> | null;
  const value = result?.[field];
  if (typeof value !== "string") {
    throw new Error(`${action} did not return ${field}`);
  }
  return value;
}

export async function seedDemoGmbH(connectionString: string): Promise<SeedIds> {
  const kernelDb = createKernelDb(connectionString);
  const kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);
  const dispatch = (actor: Actor, name: string, input: unknown, suffix: string) =>
    kernel.dispatch(actor, { name, input, idempotencyKey: `${KEY_PREFIX}:${suffix}` });

  try {
    const workspaceId = resultId(
      await dispatch({ type: "platform" }, "workspace.create", { name: "Demo GmbH", plan_code: "pilot" }, "workspace"),
      "workspace_id",
      "workspace.create",
    );

    // The kernel accepts already-resolved actor contexts. Its test suite uses
    // the same simulated-person pattern; only this first owner bootstrap lacks
    // a persisted person. Every later human invocation uses the returned owner.
    const bootstrapOwner = {
      type: "person",
      id: BOOTSTRAP_OWNER_ACTOR_ID,
      roleClass: "owner",
      workspaceId,
    } as const satisfies Actor;
    const ownerId = resultId(
      await dispatch(
        bootstrapOwner,
        "person.create",
        {
          display_name: "Anna Becker",
          role_class: "owner",
          email: "anna.becker@demo-gmbh.example",
          locale: "de",
        },
        "person:owner",
      ),
      "person_id",
      "person.create owner",
    );
    const owner = { type: "person", id: ownerId, roleClass: "owner", workspaceId } as const satisfies Actor;

    const people = [
      {
        suffix: "manager",
        input: {
          display_name: "Lukas Hoffmann",
          role_class: "manager",
          email: "lukas.hoffmann@demo-gmbh.example",
          locale: "de",
        },
      },
      {
        suffix: "supervisor:miriam-koch",
        input: {
          display_name: "Miriam Koch",
          role_class: "supervisor",
          email: "miriam.koch@demo-gmbh.example",
          locale: "de",
        },
      },
      {
        suffix: "supervisor:daniel-wagner",
        input: {
          display_name: "Daniel Wagner",
          role_class: "supervisor",
          email: "daniel.wagner@demo-gmbh.example",
          locale: "de",
        },
      },
      { suffix: "worker:emine-yilmaz", input: { display_name: "Emine Yılmaz", role_class: "worker", locale: "de" } },
      { suffix: "worker:jonas-weber", input: { display_name: "Jonas Weber", role_class: "worker", locale: "de" } },
      { suffix: "worker:sofia-petrova", input: { display_name: "Sofia Petrova", role_class: "worker", locale: "de" } },
      { suffix: "worker:david-klein", input: { display_name: "David Klein", role_class: "worker", locale: "de" } },
      { suffix: "worker:amina-diallo", input: { display_name: "Amina Diallo", role_class: "worker", locale: "de" } },
      { suffix: "worker:paul-neumann", input: { display_name: "Paul Neumann", role_class: "worker", locale: "de" } },
    ] as const;
    const personIds: string[] = [];
    for (const person of people) {
      personIds.push(
        resultId(
          await dispatch(owner, "person.create", person.input, `person:${person.suffix}`),
          "person_id",
          `person.create ${person.suffix}`,
        ),
      );
    }
    const managerId = personIds[0]!;
    const supervisorIds = [personIds[1]!, personIds[2]!] as [string, string];
    const workerIds = personIds.slice(3);

    const clientIds: string[] = [];
    for (const client of [
      {
        suffix: "nordstern-logistik",
        input: {
          name: "Nordstern Logistik AG",
          contact: { email: "betrieb@nordstern-logistik.example", phone: "+49 30 5550100" },
        },
      },
      {
        suffix: "rheinwerk-produktion",
        input: {
          name: "Rheinwerk Produktion GmbH",
          contact: { email: "werkleitung@rheinwerk.example", phone: "+49 341 5550200" },
        },
      },
    ] as const) {
      clientIds.push(
        resultId(
          await dispatch(owner, "client.create", client.input, `client:${client.suffix}`),
          "client_id",
          `client.create ${client.suffix}`,
        ),
      );
    }

    const sites = [
      {
        suffix: "berlin-logistikzentrum",
        input: {
          client_id: clientIds[0]!,
          name: "Berlin Logistikzentrum",
          address: { street: "Am Borsigturm 100", postal_code: "13507", city: "Berlin", country: "DE" },
          supervisor_person_ids: [supervisorIds[0]],
        },
        active: true,
      },
      {
        suffix: "potsdam-umschlaglager",
        input: {
          client_id: clientIds[0]!,
          name: "Potsdam Umschlaglager",
          address: { street: "Wetzlarer Straße 64", postal_code: "14482", city: "Potsdam", country: "DE" },
          supervisor_person_ids: [supervisorIds[1]],
        },
        active: true,
      },
      {
        suffix: "leipzig-werk-2",
        input: {
          client_id: clientIds[1]!,
          name: "Leipzig Werk 2",
          address: { street: "BMW-Allee 1", postal_code: "04349", city: "Leipzig", country: "DE" },
          supervisor_person_ids: [supervisorIds[0], supervisorIds[1]],
        },
        active: true,
      },
      {
        suffix: "dresden-erweiterungsflaeche",
        input: {
          client_id: clientIds[1]!,
          name: "Dresden Erweiterungsfläche",
          address: { street: "Hermann-Mende-Straße 5", postal_code: "01099", city: "Dresden", country: "DE" },
          supervisor_person_ids: [supervisorIds[1]],
        },
        active: false,
      },
    ] as const;
    const siteIds: string[] = [];
    for (const site of sites) {
      const siteId = resultId(
        await dispatch(owner, "site.create", site.input, `site:${site.suffix}:create`),
        "site_id",
        `site.create ${site.suffix}`,
      );
      siteIds.push(siteId);
      if (site.active) {
        resultId(
          await dispatch(owner, "site.activate", { site_id: siteId }, `site:${site.suffix}:activate`),
          "site_id",
          `site.activate ${site.suffix}`,
        );
      }
    }

    return {
      workspaceId,
      ownerId,
      managerId,
      supervisorIds,
      workerIds,
      clientIds: clientIds as [string, string],
      siteIds: siteIds as [string, string, string, string],
    };
  } finally {
    await kernelDb.end();
  }
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value === "") {
    throw new Error("DATABASE_URL is not configured");
  }
  return value;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("db/seed/index.ts")) {
  void seedDemoGmbH(requiredDatabaseUrl())
    .then((seeded) => {
      process.stdout.write(`Demo GmbH seeded in workspace ${seeded.workspaceId}.\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
