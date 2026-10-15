import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { readRuntimeConfigFromEnv } from '@/lib/runtimeConfig';

// Install manifest for the main app. Built per request so a deployment's own
// APP_NAME shows up when the app is installed (the icons are the product's).
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  await connection();
  const { appName } = readRuntimeConfigFromEnv();
  return {
    name: appName,
    short_name: appName,
    description: 'Queues, desks and lobby screens.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f2f6f5',
    theme_color: '#0d2a47',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
