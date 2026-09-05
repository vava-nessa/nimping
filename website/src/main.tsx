import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { NotFoundPage } from './routes/404'
import './styles.css'

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // 📖 Render the styled 404 page for any unknown URL (and for the docs
  // splat route's notFound()) instead of TanStack's bare default.
  defaultNotFoundComponent: NotFoundPage,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
