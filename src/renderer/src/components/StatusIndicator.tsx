import { Box, IconButton, Tooltip } from '@radix-ui/themes'
import { CircleAlert } from 'lucide-react'
import { Spinner } from './Spinner'
import styles from './StatusIndicator.module.css'

/**
 * Generic state shown by {@link StatusIndicator}:
 * - `ok` — a green dot (running, healthy, waiting on the user)
 * - `neutral` — a muted dot (stopped, ended, inactive)
 * - `busy` — a rotating spinner (working, starting, pending)
 * - `error` — a red alert glyph (a failure)
 */
export type StatusIndicatorState = 'ok' | 'neutral' | 'busy' | 'error'

const DOT_CLASS: Record<'ok' | 'neutral', string> = {
  ok: styles.dotOk,
  neutral: styles.dotNeutral,
}

/**
 * A small leading status glyph — a colored dot, spinner, or error icon — used as
 * the row indicator in lists. Pass `label` to describe the state in a tooltip,
 * and `onClick` to make an `error` state a clickable control (e.g. to dismiss).
 */
export function StatusIndicator({
  state,
  label,
  onClick,
}: {
  state: StatusIndicatorState
  /** Tooltip text and accessible label describing the state. */
  label?: string
  /** When set on an `error` state, renders the glyph as a clickable button. */
  onClick?: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const glyph = renderGlyph(state, label, onClick)
  return label ? <Tooltip content={label}>{glyph}</Tooltip> : glyph
}

function renderGlyph(
  state: StatusIndicatorState,
  label: string | undefined,
  onClick: ((event: React.MouseEvent) => void) | undefined,
): React.JSX.Element {
  if (state === 'busy') {
    return <Spinner aria-label={label} size={14} className={styles.spinner} />
  }

  if (state === 'error') {
    if (onClick) {
      return (
        <IconButton
          aria-label={label}
          color="red"
          variant="soft"
          size="1"
          radius="full"
          onClick={onClick}
        >
          <CircleAlert size={16} />
        </IconButton>
      )
    }
    return <CircleAlert aria-label={label} size={16} className={styles.error} />
  }

  return (
    <Box aria-label={label} className={`${styles.dot} ${DOT_CLASS[state]}`} />
  )
}
