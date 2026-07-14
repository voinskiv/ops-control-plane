const SIGN_OUT_CACHE_NAMES = ["ops-control-plane-shell-v1", "ops-control-plane-day-pack-v1"] as const;

export interface ExplicitSignOutClient {
  request(): Promise<Response>;
  deleteCache(name: (typeof SIGN_OUT_CACHE_NAMES)[number]): Promise<boolean>;
  redirect(): void;
}

export async function completeExplicitSignOut(client: ExplicitSignOutClient): Promise<boolean> {
  const response = await client.request();
  if (!response.ok) return false;
  await Promise.all(
    SIGN_OUT_CACHE_NAMES.map(async (name) => {
      await client.deleteCache(name).catch(() => false);
    }),
  );
  client.redirect();
  return true;
}
