import { readJsonFile } from '../../json'

export async function readJsonRecordFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  const parsed = await readJsonFile<unknown>(path)
  return isRecord(parsed) ? parsed : null
}

export function upsertManagedHookGroups(
  hooksValue: unknown,
  events: readonly string[],
  createHook: () => unknown,
  isManagedGroup: (group: unknown) => boolean,
): Record<string, unknown> {
  const hooks = isRecord(hooksValue) ? { ...hooksValue } : {}
  for (const event of events) {
    const existing = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[])
      : []
    const preserved = existing.filter((group) => !isManagedGroup(group))
    hooks[event] = [...preserved, { hooks: [createHook()] }]
  }
  return hooks
}

export function removeManagedHookGroups(
  hooksValue: unknown,
  isManagedGroup: (group: unknown) => boolean,
): { hooks: Record<string, unknown>; changed: boolean } {
  if (!isRecord(hooksValue)) {
    return { hooks: {}, changed: false }
  }

  let changed = false
  const hooks: Record<string, unknown> = {}
  for (const [event, value] of Object.entries(hooksValue)) {
    if (!Array.isArray(value)) {
      hooks[event] = value
      continue
    }

    const preserved = value.filter((group) => !isManagedGroup(group))
    if (preserved.length !== value.length) {
      changed = true
    }
    if (preserved.length > 0) {
      hooks[event] = preserved
    }
  }

  return { hooks, changed }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
