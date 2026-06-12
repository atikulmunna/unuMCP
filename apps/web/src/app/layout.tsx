import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "unuMCP — OpenAPI to MCP servers",
  description:
    "Turn an OpenAPI specification into a reviewed, tested, production-ready TypeScript MCP server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
