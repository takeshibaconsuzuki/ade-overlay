import { createContext } from 'react'

// Modal presence suspends only interactions in its owning UI scope.
export const InteractionScope = createContext<(() => () => void) | undefined>(
  undefined,
)
