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
