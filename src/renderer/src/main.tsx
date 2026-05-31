import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

function App(): React.JSX.Element {
  return (
    <main>
      <h1>ade-overlay</h1>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
