import {
  useId,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  Button as RadixButton,
  Callout,
  Dialog,
  Select,
  Spinner,
  TextField,
  Theme,
} from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './ui.css'

// Keep library imports, types, theme tokens, and behavior behind this boundary.
export function UIProvider({ children }: { children: ReactNode }) {
  return (
    <Theme
      appearance="dark"
      accentColor="teal"
      grayColor="slate"
      radius="medium"
    >
      {children}
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
      aria-busy={busy}
    >
      {busy && <Spinner />}
      {children}
    </RadixButton>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Text>{children}</Callout.Text>
    </Callout.Root>
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

export function Modal({
  title,
  description,
  open,
  onOpenChange,
  busy,
  trigger,
  children,
}: {
  title: string
  description: string
  open: boolean
  onOpenChange: (open: boolean) => void
  busy?: boolean
  trigger: ReactElement
  children: ReactNode
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <Dialog.Trigger>{trigger}</Dialog.Trigger>
      <Dialog.Content
        maxWidth="520px"
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
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
