import { getTranslations } from "next-intl/server";

export default async function Home() {
  const t = await getTranslations();
  return (
    <main>
      <h1>{t("app.title")}</h1>
    </main>
  );
}
