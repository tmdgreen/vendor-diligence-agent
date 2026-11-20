import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "거래처 실사 에이전트",
  description: "공시 재무 수치와 최근 악재를 모아 외상 거래 조건 초안을 만드는 에이전트",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
