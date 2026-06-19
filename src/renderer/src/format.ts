/** Format an epoch-millis timestamp as a short, locale-aware date + time. */
export function formatTimestamp(value: number): string {
  if (!value) {
    return ''
  }
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Format an epoch-millis timestamp as a compact age relative to `now`, e.g.
 * "now", "5m", "3h", "2d", "4w". Designed for tight rows where a full date
 * would crowd out the content; pair it with {@link formatTimestamp} in a
 * tooltip for the exact time.
 */
export function formatShortAge(value: number, now: number = Date.now()): string {
  if (!value) {
    return ''
  }
  const seconds = Math.max(0, Math.floor((now - value) / 1000))
  if (seconds < 60) {
    return 'now'
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d`
  }
  return `${Math.floor(days / 7)}w`
}
