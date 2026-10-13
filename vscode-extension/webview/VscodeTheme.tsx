import { useSyncExternalStore, type ReactNode } from 'react'
import { AppTheme } from '../../src/ui/AppTheme'

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => observer.disconnect()
}

function getAppearance() {
  const classes = document.body.classList
  return classes.contains('vscode-dark') ||
    classes.contains('vscode-high-contrast')
    ? 'dark'
    : 'light'
}

// VS Code can change the host theme without reloading the webview.
export function VscodeTheme({ children }: { children: ReactNode }) {
  const appearance = useSyncExternalStore(subscribe, getAppearance)
  return (
    <AppTheme appearance={appearance} className="vscode-theme">
      {children}
    </AppTheme>
  )
}
