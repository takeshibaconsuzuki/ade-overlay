import { createContext } from 'react'

// An overlay suspends interactions in its owning UI scope while present. One
// that holds focus also keeps it when its window is shown or focused again.
export const InteractionScope = createContext<
  ((holdsFocus: boolean) => () => void) | undefined
>(undefined)
