import { Theme } from '@radix-ui/themes'
import React from 'react'
import { createRoot } from 'react-dom/client'
import '@radix-ui/themes/styles.css'
import { ChatApp } from './chat/ChatApp'
import { configureApiClient } from './client'
import { App } from './controller/App'
import { Launcher } from './launcher/Launcher'
import './style.css'

configureApiClient()

const VIEW_TITLES: Record<string, string> = {
  launcher: 'ADE Overlay',
  worktrees: 'Worktrees',
  chat: 'ADE Chat',
}

// The renderer is a single-page app loaded into multiple windows; the URL hash
// selects which view to render (see src/main/controller).
const view = window.location.hash.replace(/^#/, '')
const title = VIEW_TITLES[view] ?? VIEW_TITLES.launcher
document.title = title

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Dark + iris + slate is intentional: slate-1 in dark mode is #111113, the
     * exact background the editor window hardcodes, so every surface matches.
     * Iris keeps the accent clear of the green/amber status dots. */}
    <Theme
      appearance="dark"
      accentColor="iris"
      grayColor="slate"
      radius="large"
    >
      {view === 'worktrees' ? (
        <App />
      ) : view === 'chat' ? (
        <ChatApp title={title} />
      ) : (
        <Launcher title={title} />
      )}
    </Theme>
  </React.StrictMode>,
)
