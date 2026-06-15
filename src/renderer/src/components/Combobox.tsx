import { Box, Card, ScrollArea, Text, TextField } from '@radix-ui/themes'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchableList } from '../hooks/useSearchableList'
import { VBox } from './Box'
import styles from './Combobox.module.css'

type ComboboxProps = {
  value: string
  onChange: (value: string) => void
  options: readonly string[]
  placeholder?: string
  disabled?: boolean
  emptyMessage?: string
}

const identity = (option: string): string => option

// Preferred dropdown height; the actual cap shrinks to whatever the viewport
// allows so the list never spills past the top or bottom edge of the page.
const MAX_LIST_HEIGHT = 240
// Gap between list edge and viewport edge.
const VIEWPORT_MARGIN = 4
// Gap between combobox edge and list edge.
const INPUT_GAP = 4
// The list's surrounding Card. This drives Radix's own `--card-padding` var on
// the Card below, so the rendered padding and the layout math below can never
// drift apart.
const CARD_PADDING = 0
// The `maxHeight` clamp applies to the inner scroll area, but the Card adds
// padding around it. Reserve that chrome so the *whole* card fits within the
// viewport, not just the scroll area.
//
// The card border is drawn as an inset `::after` ring (box-shadow) flush
// inside the border-box, so it adds nothing to the card's measured height and
// never enters the chrome math.
const CARD_CHROME = CARD_PADDING * 2

type Placement = {
  left: number
  width: number
  placeUp: boolean
  // Distance (px) from the viewport top (down) or bottom (up) to the list edge.
  offset: number
  maxHeight: number
  // The Radix Theme root to portal into. Portaling to <body> would drop the
  // theme's CSS variables (transparent panel) and font tokens; the theme root
  // sits above the form, so it still escapes the form's overflow clipping.
  container: HTMLElement
}

/**
 * A searchable text input backed by a filtered list of suggestions. Free text
 * is always allowed (the typed value is the source of truth); the dropdown only
 * offers matching options. Keyboard (up/down/enter/escape) and mouse share one
 * active item via {@link useSearchableList}.
 *
 * The suggestion list renders in a portal with fixed positioning, so it floats
 * above everything and is never clipped by an ancestor's overflow (e.g. the
 * surrounding form card). Its height is clamped to the room available in the
 * viewport — flipping above the input when there is more space there — so it
 * never overflows the top or bottom edge of the page.
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
  const [placement, setPlacement] = useState<Placement | null>(null)
  const inputWrapRef = useRef<HTMLDivElement>(null)

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

  // Measure the input against the viewport and position the floating list,
  // clamping its height to the room available (flipping up when there is more
  // space above). Re-run while open on scroll/resize since the input moves.
  useLayoutEffect(() => {
    if (!showList) return

    const update = (): void => {
      const el = inputWrapRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const spaceBelow =
        window.innerHeight - rect.bottom - INPUT_GAP - VIEWPORT_MARGIN
      const spaceAbove = rect.top - INPUT_GAP - VIEWPORT_MARGIN
      const placeUp = spaceBelow < MAX_LIST_HEIGHT && spaceAbove > spaceBelow
      const available = Math.max(
        0,
        (placeUp ? spaceAbove : spaceBelow) - CARD_CHROME,
      )
      setPlacement({
        left: rect.left,
        width: rect.width,
        placeUp,
        offset: placeUp
          ? window.innerHeight - (rect.top - INPUT_GAP)
          : rect.bottom + INPUT_GAP,
        maxHeight: Math.min(MAX_LIST_HEIGHT, available),
        container: el.closest<HTMLElement>('.radix-themes') ?? document.body,
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [showList, filtered.length])

  return (
    <Box ref={inputWrapRef}>
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
        placement &&
        createPortal(
          <Box
            position="fixed"
            // Keep focus on the input so clicks select instead of blurring.
            onMouseDown={(event) => event.preventDefault()}
            style={{
              left: placement.left,
              width: placement.width,
              zIndex: 50,
              ...(placement.placeUp
                ? { bottom: placement.offset }
                : { top: placement.offset }),
            }}
          >
            <Card
              // Drive Radix's own padding var from our constant so the rendered
              // padding stays in lockstep with the CARD_CHROME reservation above.
              style={
                { '--card-padding': `${CARD_PADDING}px` } as React.CSSProperties
              }
            >
              {filtered.length === 0 ? (
                <Box p="2">
                  <Text>{emptyMessage}</Text>
                </Box>
              ) : (
                <ScrollArea
                  type="auto"
                  scrollbars="vertical"
                  style={{ maxHeight: placement.maxHeight }}
                >
                  <VBox role="listbox" gap="0">
                    {filtered.map((option, index) => (
                      <Box
                        key={option}
                        className={styles.item}
                        {...getItemProps(index)}
                        p="2"
                      >
                        <Text>{option}</Text>
                      </Box>
                    ))}
                  </VBox>
                </ScrollArea>
              )}
            </Card>
          </Box>,
          placement.container,
        )}
    </Box>
  )
}
