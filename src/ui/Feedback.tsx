import { ExclamationTriangleIcon } from '@radix-ui/react-icons'
import { Callout, Flex, Spinner, Text } from '@radix-ui/themes'

export function ErrorMessage({ children }: { children: string }) {
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <Callout.Text>{children}</Callout.Text>
    </Callout.Root>
  )
}

export function LoadingScreen({ label }: { label: string }) {
  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      gap="3"
      minHeight="100vh"
      role="status"
    >
      <Spinner size="3" aria-hidden="true" />
      <Text size="2" color="gray">
        {label}
      </Text>
    </Flex>
  )
}
