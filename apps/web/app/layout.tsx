import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OpenClaude",
  description: "Claude-like agent workspace for trusted users"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
