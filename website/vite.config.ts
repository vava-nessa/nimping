import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { resolve as pathResolve } from 'node:path'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeShiki from '@shikijs/rehype'

// 📖 Resolve the vendored `sources.js` copy. The catalog lives at the
// monorepo root (`sources.js`); `./sync-website-sources.sh` (repo root)
// copies it into `website/src/_fcm-sources/sources.js` and that vendored
// copy is committed to git. This keeps the Vercel build self-contained
// (only the `website/` subdirectory is deployed) - run the sync script
// after changing the root catalog, then commit, so builds never ship
// stale data.
const fcmSourcesPath = pathResolve(
  fileURLToPath(new URL('./src/_fcm-sources/sources.js', import.meta.url)),
)

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 4328,
    strictPort: true,
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      // 📖 Mirror the tsconfig `paths` entry so Vite can resolve the same
      // 📖 alias at build/dev time. Lets the website pull `sources.js` from
      // 📖 the project root without sprinkling relative paths everywhere.
      'fcm-sources': fcmSourcesPath,
    },
  },
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    {
      enforce: 'pre',
      ...mdx({
        include: /\.mdx$/,
        providerImportSource: '@mdx-js/react',
        remarkPlugins: [
          remarkGfm,
          remarkFrontmatter,
          [remarkMdxFrontmatter, { name: 'frontmatter' }],
        ],
        rehypePlugins: [
          rehypeSlug,
          [rehypeAutolinkHeadings, { behavior: 'wrap', properties: { className: 'heading-anchor' } }],
          [
            rehypeShiki,
            {
              theme: 'github-dark',
            },
          ],
        ],
      }),
    },
    viteReact(),
    tailwindcss(),
  ],
})
