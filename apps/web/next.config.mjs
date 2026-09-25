// M04 — Next.js configuration (App Router, SSR). Tuned for mid-range Android on 4G (REQ-057).
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Hosted in the India region container (R1); standalone output keeps the image small.
  output: 'standalone',
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [360, 412, 640, 768, 1024, 1280],
  },
  experimental: {
    optimizePackageImports: ['next-intl'],
  },
  // The codebase uses NodeNext-style ".js" specifiers for ".ts" sources (LLD §0.1 convention).
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.json'],
  },
};

export default withNextIntl(nextConfig);
