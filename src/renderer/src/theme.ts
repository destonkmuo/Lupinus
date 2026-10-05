import { useEffect } from 'react'
import { useAppStore, type ThemeMode } from './store/appStore'

/** Resolve a mode to a concrete theme using the OS preference. */
export function resolveTheme(mode: ThemeMode, prefersLight: boolean): 'dark' | 'light' {
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  return prefersLight ? 'light' : 'dark'
}

/**
 * Apply the theme to this window's document. Follows OS changes live while
 * the mode is `system`. Safe to mount in every window (main + orb).
 */
export function useTheme(): void {
  const theme = useAppStore((state) => state.theme)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      document.documentElement.dataset.theme = resolveTheme(theme, mq.matches)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}
