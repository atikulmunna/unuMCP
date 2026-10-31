import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "unuMCP: OpenAPI to MCP servers",
  description:
    "Turn an OpenAPI specification into a reviewed, tested, production-ready TypeScript MCP server.",
};

// Fonts load at runtime, so the build needs no network. They are linked here,
// not @imported from globals.css, because Turbopack drops remote CSS imports.
const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,380;9..144,460;9..144,560;9..144,640&family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@420;500&display=swap";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href={FONTS_URL} />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
