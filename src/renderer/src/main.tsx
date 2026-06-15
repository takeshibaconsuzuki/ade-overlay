import { Theme } from '@radix-ui/themes'
import React from 'react'
import { createRoot } from 'react-dom/client'
import '@radix-ui/themes/styles.css'
import { configureApiClient } from './client'
import { App } from './controller/App'
import { Launcher } from './launcher/Launcher'
import './style.css'

configureApiClient()

const VIEW_TITLES: Record<string, string> = {
  launcher: 'ADE Overlay',
  worktrees: 'Worktrees',
}

// The renderer is a single-page app loaded into multiple windows; the URL hash
// selects which view to render (see src/main/controller).
const view = window.location.hash.replace(/^#/, '')
const title = VIEW_TITLES[view] ?? VIEW_TITLES.launcher
document.title = title

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Theme>{view === 'worktrees' ? <App /> : <Launcher title={title} />}</Theme>
  </React.StrictMode>,
)
