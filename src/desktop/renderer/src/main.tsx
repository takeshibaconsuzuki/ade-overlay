import React from 'react'
import { createRoot } from 'react-dom/client'
import { APP_DISPLAY_NAME } from '../../../shared/constants'
import './style.css'

function App(): React.JSX.Element {
  return (
    <main>
      <h1>{APP_DISPLAY_NAME}</h1>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
