# ops-control-plane

## Fresh clone: local Phase 0 verification

Prerequisites: Git, Node.js 24, npm, and a Docker-compatible daemon reachable by the Supabase CLI (local or through an explicitly configured remote Docker connection). The repository pins the Supabase CLI and all Node dependencies in `package-lock.json`.

Run this sequence from a shell. `supabase status` writes local development credentials only to `.env.supabase.local`, which is ignored by Git; do not commit that file or its values.

```sh
git clone https://github.com/voinskiv/ops-control-plane.git
cd ops-control-plane
npm ci

npx supabase start --workdir db --exclude edge-runtime,imgproxy,realtime,studio,vector
npx supabase status --workdir db -o env > .env.supabase.local
set -a
. ./.env.supabase.local
set +a

export DATABASE_URL="$DB_URL"
export TEST_DATABASE_URL="$DB_URL"
export SUPABASE_URL="$API_URL"
export SUPABASE_ANON_KEY="$ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3000"

npm run db:migrate
npm run db:seed
npm run typecheck
npm run lint
npm test
```

The required application variables are `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`; `NEXT_PUBLIC_APP_URL` defaults to `http://localhost:3000` but is made explicit above. `TEST_DATABASE_URL` makes the full SQL suite verify the same empty-then-migrated local Supabase database. The local CLI output supplies every secret value. The excluded services are not used in Phase 0; Postgres, Auth, API/Kong, metadata, mail, and Storage remain available.

The seed creates Demo GmbH through kernel replay only. It creates an owner, a manager, two supervisors, six display-name-only workers, two clients, and four sites; three sites are active and one remains draft. Seeded people are unlinked (`auth_user_id` remains `NULL`). Phase 1 now also replays three commitments (coverage, output, and service scope) and generates their windows across the local rolling horizon.

## Run the app (dev)

After exporting the variables in the verification sequence above, start the app:

```sh
npm run dev
```

Next uses port 3000 and binds to `0.0.0.0` by default. For remote or Tailscale access, bind explicitly and set the public app URL before starting it, using the address that the remote browser will open:

```sh
export NEXT_PUBLIC_APP_URL="http://<reachable-tailscale-address>:3000"
npm run dev -- --hostname 0.0.0.0
```

Do not expose the server publicly. Use Tailscale or an SSH tunnel only.

Open `http://127.0.0.1:3000/login` to request a magic link. Local messages are captured by the Supabase stack's Inbucket mail service; open `http://127.0.0.1:54324` to read them. The seed supplies these email values: `anna.becker@demo-gmbh.example`, `lukas.hoffmann@demo-gmbh.example`, `miriam.koch@demo-gmbh.example`, and `daniel.wagner@demo-gmbh.example`. The seeded people are not linked to Supabase auth users and the seed creates no invite/link-auth records, so a magic link for one of these addresses currently ends without a dashboard membership; signed-in verification is blocked by [issue #40](https://github.com/voinskiv/ops-control-plane/issues/40).

When signed in, `/capture` is the Heute board showing assigned active sites and today's windows. `/dashboard` shows the current workspace and role.

Stop the local stack with `npx supabase stop --workdir db`; to return to the documented seeded state, rerun the verification sequence from `npx supabase start --workdir db --exclude edge-runtime,imgproxy,realtime,studio,vector` through `npm run db:seed`.
