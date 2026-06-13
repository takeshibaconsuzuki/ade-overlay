import React from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './style.css'
import { App } from './controller/App'
import { configureApiClient } from './client'

configureApiClient()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Theme
      appearance="dark"
      accentColor="iris"
      grayColor="slate"
      radius="medium"
    >
      <App />
    </Theme>
  </React.StrictMode>,
)
