import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import './globals.css';
import { THEME_BOOT_SCRIPT } from '@/components/shell/theme';
import { Providers } from './providers';

// Self-hosted by Next (no request to Google at runtime), swapped in without layout shift.
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  // Absolute links for the share preview (opengraph-image.tsx).
  metadataBase: new URL(process.env.WEB_URL ?? 'http://localhost:3000'),
  title: 'AutoDev',
  description: 'Hand coding tasks to an AI agent that opens PRs as you.',
};

/**
 * Phones: draw under the notch (content is padded back with safe-area insets), let the keyboard
 * resize the layout on Android, and color the status bar to match the header in each scheme.
 * Zoom stays enabled; inputs are 16px on touch screens so iOS doesn't zoom into them instead.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfd' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0c0e' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
        {/* Mounted once, here, so a toast fired anywhere appears once. */}
        <Toaster theme="system" richColors closeButton mobileOffset={{ bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }} />
      </body>
    </html>
  );
}
