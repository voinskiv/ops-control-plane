import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import { getLocale, getTranslations } from "next-intl/server";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t("app.title") };
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={geist.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
