import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AegisBank 灵犀智银 · 银行 AI 智能体",
  description:
    "安全可信的银行 AI 智能体：自然语言办理转账、账单分析、理财、卡片与订阅管理，三级权限分级 + 五重安全防护。深圳国际金融科技大赛参赛作品。",
  keywords: ["AegisBank", "银行AI智能体", "AI Banking Agent", "金融科技", "权限分级", "Prompt注入防御"],
  authors: [{ name: "智御金融 · AegisBank Team" }],
  openGraph: {
    title: "AegisBank 灵犀智银",
    description: "安全可信的银行 AI 智能体",
    siteName: "AegisBank",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
