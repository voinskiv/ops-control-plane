import { getRequestConfig } from "next-intl/server";

// §15: German-first. de is the completeness-enforced catalog, en the developer
// baseline. Per-person locale resolution attaches with auth (SLICE-008); until
// then every surface renders the workspace default.
const DEFAULT_LOCALE = "de";

export default getRequestConfig(async () => {
  const locale = DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`./${locale}.json`)).default,
  };
});
