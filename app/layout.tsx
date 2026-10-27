import type { Metadata, Viewport } from 'next';
import './globals.css';
import AppShell from './_components/AppShell';
import { LocaleProvider } from '@/lib/i18n/LocaleProvider';
import { getServerI18n } from '@/lib/i18n/server';
import { getServerDeveloperMode } from '@/lib/developer-mode/server';
import { DeveloperModeProvider } from '@/lib/developer-mode/DeveloperModeProvider';
import { cookies } from 'next/headers';
import { ThemeProvider } from '@/lib/theme/ThemeProvider';
import { resolveTheme, THEME_COOKIE } from '@/lib/theme/shared';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('app.brandTitle'), description: t('app.slogan') };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { locale } = await getServerI18n();
  const developerMode = await getServerDeveloperMode();
  const theme = resolveTheme((await cookies()).get(THEME_COOKIE)?.value);
  // Browser integrations may attach root attributes before hydration. Only tolerate
  // this document-level difference; descendant hydration diagnostics stay enabled.
  return (
    <html lang={locale} data-theme={theme} suppressHydrationWarning>
      <body>
        <ThemeProvider initialTheme={theme}><LocaleProvider initialLocale={locale}><DeveloperModeProvider initialEnabled={developerMode}><AppShell>{children}</AppShell></DeveloperModeProvider></LocaleProvider></ThemeProvider>
      </body>
    </html>
  );
}
