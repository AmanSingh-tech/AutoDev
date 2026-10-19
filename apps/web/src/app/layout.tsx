import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = { title: 'AutoDev', description: 'Hand coding tasks to an AI agent that opens PRs as you.' };

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
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a101e' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
        {/* Mounted once, here, so a toast fired anywhere appears once. */}
        <Toaster theme="system" richColors closeButton mobileOffset={{ bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }} />
      </body>
    </html>
  );
}
