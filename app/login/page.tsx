import { getTranslations } from "next-intl/server";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const t = await getTranslations();
  const params = await searchParams;
  return (
    <main>
      <h1>{t("auth.login.title")}</h1>
      <form action="/api/auth/magic-link" method="post">
        <label htmlFor="email">{t("auth.login.email")}</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <button type="submit">{t("auth.login.submit")}</button>
      </form>
      {params.sent === "1" ? <p>{t("auth.login.sent")}</p> : null}
    </main>
  );
}
