import type { ReactNode } from 'react'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './theme.css'

export function AppTheme({
  children,
  appearance = 'dark',
  className = '',
}: {
  children: ReactNode
  appearance?: 'light' | 'dark'
  className?: string
}) {
  return (
    <Theme
      appearance={appearance}
      accentColor="indigo"
      grayColor="slate"
      radius="medium"
      panelBackground="solid"
      className={`ade-theme ${className}`}
    >
      {children}
    </Theme>
  )
}
