import {
  createContext,
  useCallback,
  useContext,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { Button, ScrollBox, SearchField } from './components'
import { InteractionScope } from './interaction-scope'
import { usePickerNavigation } from './use-picker-navigation'

type Register = ReturnType<typeof usePickerNavigation>['register']
const ActionContext = createContext<{
  key: string
  available: boolean
  register: Register
  activate: () => void
} | null>(null)

export function PickerAction(
  props: Omit<
    ComponentProps<typeof Button>,
    'ref' | 'disabled' | 'onClick' | 'busy'
  >,
) {
  const action = useContext(ActionContext)
  if (!action) throw new Error('PickerAction must belong to a Picker item.')
  const { key, register } = action
  const ref = useCallback(
    (element: HTMLButtonElement | null) => register(key, 'button', element),
    [key, register],
  )
  return (
    <Button
      {...props}
      className={`ui-picker-action ${props.className ?? ''}`}
      ref={ref}
      data-picker-key={key}
      disabled={!action.available}
      onClick={action.activate}
    />
  )
}

function PickerRow({
  itemKey,
  available,
  highlighted,
  register,
  activate,
  children,
}: {
  itemKey: string
  available: boolean
  highlighted: boolean
  register: Register
  activate: () => void
  children: ReactNode
}) {
  const ref = useCallback(
    (element: HTMLLIElement | null) => register(itemKey, 'row', element),
    [itemKey, register],
  )
  return (
    <li ref={ref} data-highlighted={highlighted || undefined}>
      <ActionContext.Provider
        value={{ key: itemKey, available, register, activate }}
      >
        {children}
      </ActionContext.Provider>
    </li>
  )
}

// Features own filtering, identity and row content. The picker owns interaction,
// focus, scrolling and modal suspension without inspecting feature markup.
export function Picker<T>({
  items,
  itemKey,
  available,
  resultsKey,
  onActivate,
  renderItem,
  search,
  header,
  empty,
  label,
  className,
  listClassName,
  scrollClassName,
  listId,
  busy,
}: {
  items: readonly T[]
  itemKey: (item: T) => string
  available: (item: T) => boolean
  resultsKey: string
  onActivate: (item: T) => void
  renderItem: (
    item: T,
    interaction: { tooltipDismissVersion: number },
  ) => ReactNode
  search: Omit<ComponentProps<typeof SearchField>, 'ref'>
  header?: ReactNode
  empty?: ReactNode
  label: string
  className?: string
  listClassName?: string
  scrollClassName?: string
  listId?: string
  busy?: boolean
}) {
  const entries = items.map((item) => ({
    key: itemKey(item),
    available: available(item),
  }))
  const {
    suspend,
    rootProps,
    searchRef,
    scrollRef,
    listProps,
    highlight,
    register,
    tooltipDismissVersion,
  } = usePickerNavigation(entries, resultsKey, search.value)
  return (
    <InteractionScope.Provider value={suspend}>
      <main className={className} aria-label={label} {...rootProps}>
        {header}
        <SearchField {...search} ref={searchRef} />
        {!items.length && empty}
        <ScrollBox ref={scrollRef} className={scrollClassName}>
          <ul
            {...listProps}
            id={listId}
            className={`ui-picker-list ${listClassName ?? ''}`}
            aria-label={label}
            aria-busy={busy}
          >
            {items.map((item, index) => (
              <PickerRow
                key={entries[index].key}
                itemKey={entries[index].key}
                available={entries[index].available}
                highlighted={
                  entries[index].available &&
                  highlight.key === entries[index].key
                }
                register={register}
                activate={() => onActivate(item)}
              >
                {renderItem(item, {
                  tooltipDismissVersion,
                })}
              </PickerRow>
            ))}
          </ul>
        </ScrollBox>
      </main>
    </InteractionScope.Provider>
  )
}
