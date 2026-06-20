import { LoaderCircle, type LucideProps } from 'lucide-react'
import styles from './Spinner.module.css'

/**
 * A smoothly rotating loader. Sweeps a single continuous arc rather than fading
 * discrete leaves like the default Radix spinner. Forwards every Lucide icon
 * prop, so callers can still set `size`, `color`, `aria-label`, etc.
 */
export function Spinner({
  className,
  ...props
}: LucideProps): React.JSX.Element {
  return (
    <LoaderCircle
      className={className ? `${styles.spinner} ${className}` : styles.spinner}
      {...props}
    />
  )
}
