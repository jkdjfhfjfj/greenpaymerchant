import path from 'path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer, defineConfig, loadEnv, type Plugin } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

const frontendRoot = path.resolve(import.meta.dirname);
const outDir = path.join(frontendRoot, 'dist/public');
const aliases = {
  '@': path.resolve(frontendRoot, 'src'),
  '@assets': path.resolve(frontendRoot, '..', '..', 'attached_assets'),
};
function getPublicSiteUrl(mode: string): string {
  const env = loadEnv(mode, frontendRoot, '');
  const configuredSiteUrl = env.VITE_PUBLIC_SITE_URL?.trim() || env.PUBLIC_SITE_URL?.trim();
  let siteUrl = 'https://empty-project.replit.app';
  if (configuredSiteUrl) {
    try {
      const configured = new URL(configuredSiteUrl);
      const hostname = configured.hostname.toLowerCase();
      const isDevelopmentHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.replit.dev');
      if (configured.protocol === 'https:' && !isDevelopmentHost) siteUrl = configured.origin;
      else if (mode === 'production') throw new Error('VITE_PUBLIC_SITE_URL must be a published HTTPS site URL, not a development host.');
    } catch (error) {
      if (mode === 'production') throw error instanceof Error ? error : new Error('VITE_PUBLIC_SITE_URL is invalid.');
    }
  }
  return siteUrl;
}
const developmentToolingPlugins =
  process.env.NODE_ENV !== 'production' && process.env.REPL_ID !== undefined
    ? [
        await import('@replit/vite-plugin-cartographer').then((m) =>
          m.cartographer({ root: path.resolve(import.meta.dirname, '..') }),
        ),
        await import('@replit/vite-plugin-dev-banner').then((m) => m.devBanner()),
      ]
    : [];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function prerenderHead(
  html: string,
  input: { title: string; description: string; path: string; siteUrl: string },
): string {
  const canonical = new URL(input.path, `${input.siteUrl}/`).toString();
  const title = escapeHtml(input.title);
  const description = escapeHtml(input.description);
  const graph = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${input.siteUrl}/#organization`,
      name: 'Greenpay',
      url: `${input.siteUrl}/`,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${input.siteUrl}/#website`,
      name: 'Greenpay',
      url: `${input.siteUrl}/`,
      publisher: { '@id': `${input.siteUrl}/#organization` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: input.title,
      description: input.description,
      url: canonical,
      isPartOf: { '@id': `${input.siteUrl}/#website` },
      publisher: { '@id': `${input.siteUrl}/#organization` },
    },
  ];
  const jsonLd = JSON.stringify(graph).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${description}">`)
    .replace(/<meta name="robots"[^>]*>/i, '<meta name="robots" content="index, follow">')
    .replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${escapeHtml(canonical)}">`)
    .replace(/<meta property="og:site_name"[^>]*>/i, '<meta property="og:site_name" content="Greenpay">')
    .replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${title}">`)
    .replace(/<meta property="og:description"[^>]*>/i, `<meta property="og:description" content="${description}">`)
    .replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${escapeHtml(canonical)}">`)
    .replace(/<meta property="og:type"[^>]*>/i, '<meta property="og:type" content="website">')
    .replace(/<meta name="twitter:card"[^>]*>/i, '<meta name="twitter:card" content="summary">')
    .replace(/<meta name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${title}">`)
    .replace(/<meta name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${description}">`)
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/i, `<script type="application/ld+json">${jsonLd}</script>`);
}

function prerenderPublicPages(siteUrl: string): Plugin {
  return {
    name: 'greenpay-static-public-prerender',
    apply: 'build',
    async closeBundle() {
      const ssrServer = await createServer({
        configFile: false,
        root: frontendRoot,
        base: basePath,
        plugins: [react(), tailwindcss()],
        resolve: { alias: aliases, dedupe: ['react', 'react-dom'] },
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true },
        appType: 'custom',
        logLevel: 'error',
      });
      try {
        const [{ default: HomePage }, { ContactPage }] = await Promise.all([
          ssrServer.ssrLoadModule('/src/pages/home.tsx'),
          ssrServer.ssrLoadModule('/src/pages/contact.tsx'),
        ]);
        const homeMarkup = renderToStaticMarkup(createElement(HomePage))
          .replace(/class="([^"]*\bhp-reveal\b[^"]*)"/g, (_match, classes: string) => {
            const classNames = classes.split(/\s+/).filter(Boolean);
            if (!classNames.includes('in')) classNames.push('in');
            return `class="${classNames.join(' ')}"`;
          });
        const contactMarkup = renderToStaticMarkup(createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ContactPage),
        ));
        const indexPath = path.join(outDir, 'index.html');
        const indexTemplate = await readFile(indexPath, 'utf8');
        const homeHead = prerenderHead(indexTemplate, {
          title: 'Greenpay | Payment collection and business finance records',
          description: 'Greenpay helps businesses collect payments with links and review confirmed transactions, settlement evidence, invoices, refunds and payout records.',
          path: '/',
          siteUrl,
        });
        await writeFile(indexPath, homeHead.replace('<div id="root"></div>', `<div id="root">${homeMarkup}</div>`));

        const contactHtml = prerenderHead(indexTemplate, {
          title: 'Contact Greenpay Support',
          description: 'Contact Greenpay about payments, your account, business verification or a technical issue. Do not include passwords or payment credentials.',
          path: '/contact',
          siteUrl,
        }).replace('<div id="root"></div>', `<div id="root">${contactMarkup}</div>`);
        const contactDir = path.join(outDir, 'contact');
        await mkdir(contactDir, { recursive: true });
        await writeFile(path.join(contactDir, 'index.html'), contactHtml);
      } finally {
        await ssrServer.close();
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const siteUrl = getPublicSiteUrl(mode);
  return {
    base: basePath,
    define: {
      'import.meta.env.VITE_PUBLIC_SITE_URL': JSON.stringify(siteUrl),
    },
    plugins: [
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      prerenderPublicPages(siteUrl),
      ...developmentToolingPlugins,
    ],
    resolve: {
      alias: aliases,
      dedupe: ['react', 'react-dom'],
    },
    root: frontendRoot,
    build: {
      outDir,
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts: true,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
