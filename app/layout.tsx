import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Banking Agent',
  description: 'AI Banking Agent competition demo',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
