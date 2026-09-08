import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Meme Scout · 链上排雷工作台',
  description: '自动发现热门小市值代币，核验合约权限、LP、持仓与 X 讨论证据。',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="dark">
      <body>{children}</body>
    </html>
  );
}
