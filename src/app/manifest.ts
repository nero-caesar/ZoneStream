import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ZoneStream | Nigeria South South Zone 1",
    short_name: "ZoneStream",
    description: "Your connection to Nigeria South South Zone 1.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#09090f",
    theme_color: "#0b0b12",
    icons: [{ src: "/logo.png", type: "image/png" }],
  };
}
