import { useCallback } from 'react'
import { Flex, IconButton, Text } from '@radix-ui/themes'
import { X } from 'lucide-react'

/**
 * A custom titlebar for frameless windows. The bar itself is the drag handle
 * (`-webkit-app-region: drag`, which is Chromium-level and works on every
 * platform); the close button opts out so it stays clickable. Closing routes
 * through the privileged desktop bridge to close the host window.
 */
export function Titlebar({ title }: { title: string }): React.JSX.Element {
  const handleClose = useCallback(async (): Promise<void> => {
    await window.desktop?.closeWindow()
  }, [])

  return (
    <Flex
      align="center"
      justify="between"
      px="2"
      height="32px"
      style={
        {
          WebkitAppRegion: 'drag',
          backgroundColor: 'var(--accent-9)',
          color: 'var(--accent-contrast)',
        } as React.CSSProperties
      }
    >
      <Text size="1" weight="medium">
        {title}
      </Text>
      <IconButton
        size="1"
        variant="ghost"
        color="gray"
        highContrast
        aria-label="Close window"
        onClick={handleClose}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <X size={14} />
      </IconButton>
    </Flex>
  )
}
