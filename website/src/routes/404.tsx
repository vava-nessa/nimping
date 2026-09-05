/**
 * @file src/routes/404.tsx
 * @description Dark 404 Not Found page.
 */
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/404')({
  component: NotFoundPage,
})

/** 📖 Exported so `main.tsx` can use it as the router's
 *  `defaultNotFoundComponent` for unknown URLs (and bad doc slugs). */
export function NotFoundPage() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-5 text-center">
      <span className="font-mono text-6xl font-bold text-accent-fg">404</span>
      <h1 className="mt-4 font-mono text-xl font-semibold text-fg">Page Not Found</h1>
      <p className="mt-2 font-mono text-xs text-fg-muted">
        The documentation or page you requested could not be found.
      </p>
      <Link
        to="/"
        className="mt-6 rounded-md bg-accent px-4 py-2 font-mono text-xs font-semibold text-ink transition-transform hover:-translate-y-0.5"
      >
        Return to Home →
      </Link>
    </div>
  )
}
