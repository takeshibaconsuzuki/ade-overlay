import {
  Flex,
  Grid as RadixGrid,
  type FlexProps,
  type GridProps,
} from '@radix-ui/themes'
import { forwardRef } from 'react'

/**
 * A horizontal {@link Flex} (row). Forwards every Flex prop, so `direction` can
 * still be overridden for responsive layouts.
 */
export const HBox = forwardRef<HTMLDivElement, FlexProps>(
  function HBox(props, ref) {
    return (
      <Flex
        ref={ref}
        direction="row"
        justify="between"
        align="center"
        gap="2"
        {...props}
      />
    )
  },
)

/**
 * A vertical {@link Flex} (column). Forwards every Flex prop, so `direction` can
 * still be overridden for responsive layouts.
 */
export const VBox = forwardRef<HTMLDivElement, FlexProps>(
  function VBox(props, ref) {
    return (
      <Flex ref={ref} direction="column" justify="between" gap="2" {...props} />
    )
  },
)

/**
 * A CSS {@link Grid}. Forwards every Grid prop, including the `columns`/`rows`
 * track templates and per-child `gridColumn`/`gridRow` placement, so callers
 * describe a layout once instead of hand-writing grid CSS.
 */
export const Grid = forwardRef<HTMLDivElement, GridProps>(
  function Grid(props, ref) {
    return <RadixGrid ref={ref} gap="2" {...props} />
  },
)
