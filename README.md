# ops-control-plane

## Fresh clone: local Phase 0 verification

Prerequisites: Git, Node.js 24, npm, and a Docker-compatible daemon reachable by the Supabase CLI (local or through an explicitly configured remote Docker connection). The repository pins the Supabase CLI and all Node dependencies in `package-lock.json`.

Run this sequence from a shell. `supabase status` writes local development credentials only to `.env.supabase.local`, which is ignored by Git; do not commit that file or its values.

```sh
git clone https://github.com/voinskiv/ops-control-plane.git
cd ops-control-plane
npm ci

npx supabase start --workdir db
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

The required application variables are `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`; `NEXT_PUBLIC_APP_URL` defaults to `http://localhost:3000` but is made explicit above. `TEST_DATABASE_URL` makes the full SQL suite verify the same empty-then-migrated local Supabase database. The local CLI output supplies every secret value.

The Phase 0 seed creates Demo GmbH through kernel replay only. It creates an owner, a manager, two supervisors, six display-name-only workers, two clients, and four sites; three sites are active and one remains draft. Seeded people are unlinked (`auth_user_id` remains `NULL`), and no credentials, commitments, windows, or records are created. Commitment/window fixtures are deferred to SLICE-014A (Phase 1).
