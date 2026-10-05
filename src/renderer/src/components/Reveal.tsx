import { useEffect, useRef, useState } from 'react'

interface RevealProps {
  /** Accessible name for the revealed region (usually the section heading). */
  label?: string
  className?: string
  children: React.ReactNode
}

/**
 * Wraps a below-fold block so it fades/rises in once it scrolls into view.
 * Pairs with the `.reveal` / `.reveal.is-visible` rules in main.css. Renders
 * visible immediately when IntersectionObserver is unavailable, and honors
 * reduced motion via CSS.
 */
function Reveal({ label, className, children }: RevealProps): React.JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    if (visible) return
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible])

  return (
    <section
      ref={ref}
      aria-label={label}
      className={`reveal${visible ? ' is-visible' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </section>
  )
}

export default Reveal
