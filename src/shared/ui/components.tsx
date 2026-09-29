import {
  useId,
  useCallback,
  useContext,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react'
import {
  Button as RadixButton,
  Callout,
  Dialog,
  DropdownMenu,
  Skeleton as RadixSkeleton,
  Select,
  ScrollArea as RadixScrollArea,
  Spinner as RadixSpinner,
  TextField,
  Theme,
  Tooltip as RadixTooltip,
} from '@radix-ui/themes'
import { Slot, Tooltip as TooltipPrimitive } from 'radix-ui'
import '@radix-ui/themes/styles.css'
import './ui.css'
import { InteractionScope } from './interaction-scope'
import type { WorktreeColor } from '../worktree-colors.ts'

// Keep library imports, types, theme tokens, and behavior behind this boundary.
export function UIProvider({ children }: { children: ReactNode }) {
  return (
    <Theme
      appearance="dark"
      accentColor="teal"
      grayColor="slate"
      radius="medium"
    >
      <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={0}>
        {children}
      </TooltipPrimitive.Provider>
    </Theme>
  )
}

export function Button({
  tone = 'primary',
  busy = false,
  children,
  disabled,
  ...props
}: ComponentPropsWithRef<'button'> & {
  tone?: 'primary' | 'secondary' | 'danger'
  busy?: boolean
}) {
  return (
    <RadixButton
      {...props}
      type={props.type ?? 'button'}
      variant={tone === 'primary' ? 'solid' : 'soft'}
      color={tone === 'danger' ? 'red' : undefined}
      disabled={disabled || busy}
      loading={busy}
      aria-busy={busy || (props['aria-busy'] ?? false)}
    >
      {children}
    </RadixButton>
  )
}

export function Spinner() {
  return <RadixSpinner size="2" aria-hidden />
}

export function ChoiceMenu({
  value,
  items,
  onChange,
  children,
}: {
  value: string
  items: readonly { id: string; label: string }[]
  onChange: (value: string) => void
  children: ReactElement
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup value={value}>
          {items.map((item) => (
            <DropdownMenu.RadioItem
              key={item.id}
              value={item.id}
              onSelect={() => onChange(item.id)}
            >
              {item.label}
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

export function ActionMenu({
  children,
  items,
  restoreFocus = true,
}: {
  children: ReactElement
  items: readonly {
    label: string
    disabled?: boolean
    title?: string
    onSelect: () => void
    tone?: 'danger'
  }[]
  restoreFocus?: boolean
}) {
  const contentRef = useInteractionScopeRef()
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Content
        ref={contentRef}
        align="end"
        onCloseAutoFocus={(event) => {
          if (!restoreFocus) event.preventDefault()
        }}
      >
        {items.map((item) => (
          <DropdownMenu.Item
            key={item.label}
            disabled={item.disabled}
            title={item.title}
            color={item.tone === 'danger' ? 'red' : undefined}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

export function SkeletonLine({ label }: { label: string }) {
  return (
    <span role="img" aria-label={label}>
      <RadixSkeleton>
        <span className="ui-skeleton-line">&nbsp;</span>
      </RadixSkeleton>
    </span>
  )
}

export function Tooltip({
  content,
  children,
  dismissVersion = 0,
  keepOpenOnClick = false,
}: {
  content?: string
  children: ReactElement
  dismissVersion?: number
  keepOpenOnClick?: boolean
}) {
  const [openVersion, setOpenVersion] = useState<number | null>(null)
  const interactionVersion = useRef(dismissVersion)
  const ignoredPointerDown = useRef<Event | null>(null)
  function preventIgnoredClick(event: SyntheticEvent<HTMLElement>) {
    const button = (event.target as Element).closest('button')
    if (
      button
        ? button.disabled || button.getAttribute('aria-disabled') === 'true'
        : keepOpenOnClick
    ) {
      event.preventDefault()
      if (event.type === 'pointerdown')
        ignoredPointerDown.current = event.nativeEvent
    }
  }
  const onPointerMove: HTMLAttributes<HTMLElement>['onPointerMove'] = () => {
    // A delayed hover may finish after keyboard navigation dismissed it.
    interactionVersion.current = dismissVersion
  }
  const onFocus: HTMLAttributes<HTMLElement>['onFocus'] = () => {
    interactionVersion.current = dismissVersion
  }
  const onPointerDown: HTMLAttributes<HTMLElement>['onPointerDown'] = (
    event,
  ) => {
    preventIgnoredClick(event)
  }
  const onClick: HTMLAttributes<HTMLElement>['onClick'] = (event) => {
    preventIgnoredClick(event)
  }
  return (
    <RadixTooltip
      content={content}
      open={!!content && openVersion === dismissVersion}
      onOpenChange={(next) =>
        setOpenVersion(content && next ? interactionVersion.current : null)
      }
      onPointerDownOutside={(event) => {
        if (event.detail.originalEvent === ignoredPointerDown.current)
          event.preventDefault()
      }}
      disableHoverableContent
    >
      <Slot.Root
        onPointerMove={onPointerMove}
        onFocus={onFocus}
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        {children}
      </Slot.Root>
    </RadixTooltip>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Text>{children}</Callout.Text>
    </Callout.Root>
  )
}

export function SearchField(
  props: Pick<
    ComponentPropsWithRef<'input'>,
    | 'ref'
    | 'className'
    | 'aria-label'
    | 'aria-controls'
    | 'placeholder'
    | 'onChange'
    | 'onFocus'
    | 'onKeyDown'
    | 'autoFocus'
  > & { value: string },
) {
  return <TextField.Root {...props} type="search" size="3" autoComplete="off" />
}

export function ScrollBox(
  props: Pick<ComponentPropsWithRef<'div'>, 'ref' | 'className' | 'children'>,
) {
  return (
    <RadixScrollArea
      {...props}
      className={`ui-scrollbox ${props.className ?? ''}`}
      data-ui-scroll-viewport=""
      scrollbars="vertical"
      type="auto"
    />
  )
}

export function Field({
  label,
  hint,
  ...props
}: Pick<
  ComponentPropsWithRef<'input'>,
  | 'name'
  | 'onChange'
  | 'onBlur'
  | 'placeholder'
  | 'required'
  | 'disabled'
  | 'autoFocus'
  | 'autoComplete'
  | 'maxLength'
  | 'pattern'
  | 'ref'
> & {
  label: string
  hint?: string
  value?: string
  defaultValue?: string
  type?: 'text' | 'email' | 'password' | 'search' | 'url'
}) {
  const id = useId()
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      <TextField.Root
        {...props}
        id={id}
        size="3"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  )
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      <Select.Root
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        size="3"
      >
        <Select.Trigger id={id} className="ui-select" />
        <Select.Content>
          {options.map((option) => (
            <Select.Item key={option.value} value={option.value}>
              {option.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </div>
  )
}

function useInteractionScopeRef() {
  const suspend = useContext(InteractionScope)
  const release = useRef<(() => void) | undefined>(undefined)
  return useCallback(
    (element: HTMLDivElement | null) => {
      release.current?.()
      release.current = element ? suspend?.() : undefined
    },
    [suspend],
  )
}

export function Modal({
  title,
  description,
  open,
  onOpenChange,
  trigger,
  returnFocusRef,
  children,
}: {
  title: string
  description: string
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger?: ReactElement
  returnFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const contentRef = useInteractionScopeRef()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger>{trigger}</Dialog.Trigger>}
      <Dialog.Content
        ref={contentRef}
        maxWidth="520px"
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault()
            returnFocusRef.current.focus({ preventScroll: true })
          }
        }}
      >
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description className="ui-dialog-description">
          {description}
        </Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  )
}

export function WorktreeName({
  color,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'color'> & {
  color?: WorktreeColor
}) {
  return (
    <span
      {...props}
      style={{
        ...props.style,
        color: `var(--app-worktree-${color ?? 'unopened'})`,
      }}
    >
      {children}
    </span>
  )
}
