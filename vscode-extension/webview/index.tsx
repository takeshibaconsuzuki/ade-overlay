import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { VscodeTheme } from './VscodeTheme'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VscodeTheme>
      <App />
    </VscodeTheme>
  </StrictMode>,
)
