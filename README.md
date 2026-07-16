# ops-control-plane

## Fresh clone: verify current main locally

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

The required application variables are `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`; `NEXT_PUBLIC_APP_URL` defaults to `http://localhost:3000` but is made explicit above. The local CLI output supplies every secret value. The excluded services are not used by the current stack; Postgres, Auth, API/Kong, metadata, mail, and Storage remain available.

The test suite has two database modes:

- **Default — embedded PostgreSQL:** do not export `TEST_DATABASE_URL`. The test harness boots a real, ephemeral PostgreSQL 17 server for each run, applies the migrations, and tears down the server and temporary data afterward. This matches CI and is the right mode once the local development database carries working state.
- **Supabase verification — disposable local stack:** use this only against a freshly reset stack, immediately after `stop --no-backup` and `start`, before any seed or auth bootstrap:

  ```sh
  npx supabase stop --workdir db --no-backup
  npx supabase start --workdir db --exclude edge-runtime,imgproxy,realtime,studio,vector
  npx supabase status --workdir db -o env > .env.supabase.local
  set -a
  . ./.env.supabase.local
  set +a
  export TEST_DATABASE_URL="$DB_URL"
  npm test
  unset TEST_DATABASE_URL
  ```

  `TEST_DATABASE_URL` targets this disposable database and makes the harness skip its own database provisioning and teardown. The schema, RLS, and immutability suites are most meaningful in this mode: the harness comment in `tests/helpers/global-setup.ts` documents the explicit `app_kernel` membership needed to exercise local Supabase's PostgreSQL role semantics. The run applies migrations and leaves test fixtures behind, so it consumes the database's freshness; reset it again before another Supabase-verification run or before building normal development state.

The pinned demo fixture creates Demo GmbH through kernel replay only. It creates an owner, a manager, two supervisors, six display-name-only workers, two clients, and four sites; three sites are active and one remains draft. Seeded people are unlinked (`auth_user_id` remains `NULL`). It also replays three commitments (coverage, output, and service scope) and generates their windows across the local rolling horizon.

## Run the app (dev)

After exporting the variables and running `npm run db:seed` in the verification sequence above, bootstrap the seeded owner's local auth identity:

```sh
npm run dev:bootstrap
```

The command replays the existing self-invite and `person.link_auth` kernel actions for `anna.becker@demo-gmbh.example`, creates or updates the matching local Supabase user, and refuses any non-local `SUPABASE_URL` or `DATABASE_URL`. Its fixed local fallback password is `local-dev-password`.

Then start the app:

```sh
npm run dev
```

Next uses port 3000 and binds to `0.0.0.0` by default. For remote or Tailscale access, bind explicitly and set the public app URL before starting it, using the address that the remote browser will open:

```sh
export NEXT_PUBLIC_APP_URL="http://<reachable-tailscale-address>:3000"
npm run dev -- --hostname 0.0.0.0
```

Do not expose the server publicly. Use Tailscale or an SSH tunnel only. The local Supabase stack binds its published development services to `0.0.0.0` with shared default credentials. On any machine with a public interface, firewall the development ports (`3000`, `54321`, `54322`, and `54324`) to Tailscale/loopback only; never expose them publicly.

Open `http://127.0.0.1:3000/login` to request a magic link for `anna.becker@demo-gmbh.example`. Local messages are captured by the Supabase stack's Mailpit service; open `http://127.0.0.1:54324` to read them. The seed also supplies `lukas.hoffmann@demo-gmbh.example`, `miriam.koch@demo-gmbh.example`, and `daniel.wagner@demo-gmbh.example` for later invite flows.

When signed in, `/capture` is the Heute board showing assigned active sites and today's windows. `/dashboard` shows the current workspace and role.

Stop the local stack with `npx supabase stop --workdir db`; plain `stop` preserves its data volumes. For a true reset, run `npx supabase stop --workdir db --no-backup`, then rerun the verification sequence from `npx supabase start --workdir db --exclude edge-runtime,imgproxy,realtime,studio,vector` through `npm run db:seed`.
