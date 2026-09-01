import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UOTAGE",
  description: "ステップ配信／デッドラインファネル",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
