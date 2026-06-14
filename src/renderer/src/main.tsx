import React from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './style.css'
import { App } from './controller/App'
import { Launcher } from './launcher/Launcher'
import { configureApiClient } from './client'

configureApiClient()

// The renderer is a single-page app loaded into multiple windows; the URL hash
// selects which view to render (see src/main/controller).
const view = window.location.hash.replace(/^#/, '')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Theme
      appearance="dark"
      accentColor="iris"
      grayColor="slate"
      radius="medium"
    >
      {view === 'worktrees' ? <App /> : <Launcher />}
    </Theme>
  </React.StrictMode>,
)
