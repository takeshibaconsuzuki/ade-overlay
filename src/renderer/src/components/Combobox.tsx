import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Card, Flex, ScrollArea, Text, TextField } from '@radix-ui/themes'
import { useSearchableList } from './useSearchableList'

type ComboboxProps = {
  value: string
  onChange: (value: string) => void
  options: readonly string[]
  placeholder?: string
  disabled?: boolean
  emptyMessage?: string
}

type DropdownPosition = {
  left: number
  width: number
  maxHeight: number
} & ({ top: number } | { bottom: number })

const identity = (option: string): string => option

const MARGIN = 4
const MAX_DROPDOWN_HEIGHT = 240

/**
 * A searchable text input backed by a filtered list of suggestions. Free text
 * is always allowed (the typed value is the source of truth); the dropdown only
 * offers matching options. Keyboard (up/down/enter/escape) and mouse share one
 * active item via {@link useSearchableList}.
 *
 * The dropdown is portalled to the body and positioned with `fixed` coordinates
 * so it is never clipped by — or expand the scroll area of — its container, and
 * it flips above the input when there is not enough room below.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  emptyMessage = 'No matching branches',
}: ComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<DropdownPosition | null>(null)
  const [portalContainer, setPortalContainer] = useState<Element | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)

  const select = useCallback(
    (option: string) => {
      onChange(option)
      setOpen(false)
    },
    [onChange],
  )

  const { filtered, onKeyDown, getItemProps } = useSearchableList({
    items: options,
    getText: identity,
    query: value,
    onSelect: select,
  })

  const showList = open && options.length > 0

  useLayoutEffect(() => {
    if (!showList) {
      return
    }

    // Portal into the Radix Theme root (not document.body) so the dropdown keeps
    // the theme's CSS variables — fonts, panel background, spacing scale.
    setPortalContainer(
      anchorRef.current?.closest('.radix-themes') ?? document.body,
    )

    const updatePosition = (): void => {
      const anchor = anchorRef.current
      if (!anchor) {
        return
      }
      const rect = anchor.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom - MARGIN
      const spaceAbove = rect.top - MARGIN
      const placeBelow = spaceBelow >= spaceAbove
      const maxHeight = Math.min(
        MAX_DROPDOWN_HEIGHT,
        Math.max(placeBelow ? spaceBelow : spaceAbove, 0),
      )
      const shared = { left: rect.left, width: rect.width, maxHeight }
      setPosition(
        placeBelow
          ? { ...shared, top: rect.bottom + MARGIN }
          : { ...shared, bottom: window.innerHeight - rect.top + MARGIN },
      )
    }

    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [showList])

  return (
    <Box ref={anchorRef}>
      <TextField.Root
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            return
          }
          if (!open) {
            // While closed, let arrows reopen the list but leave Enter free to
            // submit the surrounding form.
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
            }
            return
          }
          onKeyDown(event)
        }}
      />

      {showList &&
        position &&
        portalContainer &&
        createPortal(
          <Card
            // Keep focus in the input so blur-to-close does not fire on click.
            onMouseDown={(event) => event.preventDefault()}
            style={{
              position: 'fixed',
              left: position.left,
              width: position.width,
              top: 'top' in position ? position.top : undefined,
              bottom: 'bottom' in position ? position.bottom : undefined,
              zIndex: 1000,
              padding: 'var(--space-1)',
              // Float over page content with a fully opaque surface.
              backgroundColor: 'var(--color-panel-solid)',
            }}
          >
            {filtered.length === 0 ? (
              <Flex p="2">
                <Text size="2" color="gray">
                  {emptyMessage}
                </Text>
              </Flex>
            ) : (
              <ScrollArea
                type="auto"
                scrollbars="vertical"
                style={{ maxHeight: position.maxHeight }}
              >
                <Box role="listbox">
                  {filtered.map((option, index) => (
                    <Box
                      key={option}
                      className="searchable-option"
                      px="2"
                      py="1"
                      {...getItemProps(index)}
                    >
                      <Text size="2" truncate>
                        {option}
                      </Text>
                    </Box>
                  ))}
                </Box>
              </ScrollArea>
            )}
          </Card>,
          portalContainer,
        )}
    </Box>
  )
}
