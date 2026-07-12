import { runDueCommitmentCompletion } from "@core/actions/commitment-cron-runtime";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response(null, { status: 401 });
  }
  await runDueCommitmentCompletion();
  return new Response(null, { status: 204 });
}
