import { IconButton, Text } from '@radix-ui/themes'
import { X } from 'lucide-react'
import { useCallback } from 'react'
import { HBox } from './Box'
import styles from './Titlebar.module.css'

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
    <HBox className={styles.titlebar} style={dragStyle} px="3" py="2">
      <Text size="1" weight="medium" color="gray">
        {title}
      </Text>
      <HBox style={noDragStyle}>
        <IconButton
          aria-label="Close window"
          onClick={handleClose}
          variant="ghost"
          color="gray"
          size="1"
        >
          <X size={16} />
        </IconButton>
      </HBox>
    </HBox>
  )
}
