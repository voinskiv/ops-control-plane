import type { MetadataRoute } from "next";

import de from "@core/i18n/de.json";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: de.app.title,
    short_name: de.app.short_name,
    start_url: "/capture",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#171717",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
