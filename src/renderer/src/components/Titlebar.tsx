import { IconButton, Text } from '@radix-ui/themes'
import { X } from 'lucide-react'
import { useCallback } from 'react'
import { HBox } from './Box'

/**
 * A simple titlebar surface with a close action routed through the privileged
 * desktop bridge.
 */
export function Titlebar({ title }: { title: string }): React.JSX.Element {
  const handleClose = useCallback(async (): Promise<void> => {
    await window.desktop?.closeWindow()
  }, [])

  const dragStyle = { WebkitAppRegion: 'drag' }
  const noDragStyle = { WebkitAppRegion: 'no-drag' }

  return (
    <HBox style={dragStyle} p="2">
      <Text>{title}</Text>
      <HBox style={noDragStyle}>
        <IconButton aria-label="Close window" onClick={handleClose}>
          <X />
        </IconButton>
      </HBox>
    </HBox>
  )
}
