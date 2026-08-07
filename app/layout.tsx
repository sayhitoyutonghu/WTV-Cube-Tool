import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3001";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title: "WTV Cube Studio",
    description: "Create responsive, timing-controlled WTV cube bumper sequences for TikTok, Instagram, and YouTube.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "WTV Cube Studio",
      description: "Realtime bumper generator for the WTV album rollout.",
      type: "website",
      images: [{ url: imageUrl, width: 1680, height: 945, alt: "WTV Cube Studio realtime bumper generator" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "WTV Cube Studio",
      description: "Realtime bumper generator for the WTV album rollout.",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
