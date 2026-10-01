import { useId, useState, type ComponentProps } from 'react'
import { TextField } from '@radix-ui/themes'
import { Popover } from 'radix-ui'
import { ScrollBox, type Field } from './components'
import { usePickerNavigation } from './use-picker-navigation'

export function SearchableField({
  suggestions,
  onChange,
  label,
  hint,
  value = '',
  ...props
}: Omit<ComponentProps<typeof Field>, 'onChange' | 'ref' | 'defaultValue'> & {
  suggestions: readonly string[]
  onChange: (value: string) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const expanded = open && !props.disabled
  const items = expanded
    ? suggestions.filter((suggestion) =>
        suggestion.toLowerCase().includes(value.toLowerCase()),
      )
    : []
  const { rootProps, searchRef, scrollRef, listProps, highlight, register } =
    usePickerNavigation(
      items.map((key) => ({ key, available: true })),
      JSON.stringify(items),
      value,
      0,
      { focusOnWindowFocus: false },
    )
  const activeIndex = items.indexOf(highlight.key ?? '')
  return (
    <section className="ui-field" {...rootProps}>
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <Popover.Root open={expanded} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div>
            <TextField.Root
              {...props}
              id={id}
              ref={searchRef}
              size="3"
              value={value}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={expanded}
              aria-controls={expanded ? `${id}-list` : undefined}
              aria-activedescendant={
                activeIndex < 0 ? undefined : `${id}-option-${activeIndex}`
              }
              aria-describedby={hint ? `${id}-hint` : undefined}
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onChange={(event) => {
                onChange(event.target.value)
                setOpen(event.target === document.activeElement)
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (expanded && event.key === 'Enter' && activeIndex < 0) {
                  event.preventDefault()
                  if (!event.repeat) setOpen(false)
                }
                if (
                  !expanded &&
                  (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                ) {
                  event.preventDefault()
                  setOpen(true)
                }
                if (event.key === 'Tab') setOpen(false)
              }}
            />
          </div>
        </Popover.Anchor>
        <Popover.Content
          role="presentation"
          className="ui-field-dropdown"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target === searchRef.current) event.preventDefault()
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            setOpen(false)
          }}
        >
          {!items.length && (
            <p className="ui-field-picker-empty" role="status">
              No results
            </p>
          )}
          <ScrollBox ref={scrollRef}>
            <ul
              {...listProps}
              id={`${id}-list`}
              className="ui-picker-list"
              role="listbox"
              aria-labelledby={`${id}-label`}
            >
              {items.map((item, index) => (
                <li
                  key={item}
                  role="presentation"
                  ref={(element) => register(item, 'row', element)}
                  data-highlighted={highlight.key === item || undefined}
                >
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={`${id}-option-${index}`}
                    aria-selected={highlight.key === item}
                    ref={(element) => register(item, 'button', element)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onChange(item)
                      setOpen(false)
                    }}
                  >
                    {item}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollBox>
        </Popover.Content>
      </Popover.Root>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </section>
  )
}
