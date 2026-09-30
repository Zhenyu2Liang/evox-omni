import type { Metadata } from 'next';
import './globals.css';
import NavBar from './_components/NavBar';

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
      <body className="flex min-h-screen flex-col">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
