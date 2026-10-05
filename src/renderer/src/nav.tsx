/* eslint-disable react-refresh/only-export-components */
import {
  AgentIcon,
  CalendarIcon,
  GraphIcon,
  HomeIcon,
  MailIcon,
  TaskIcon,
  MoreIcon,
  SettingsIcon
} from './components/icons'
import type { NavKey } from './store/appStore'

export interface NavItem {
  key: NavKey
  label: string
  icon: (props: { size?: number }) => React.JSX.Element
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: 'Home', icon: HomeIcon },
  { key: 'graph', label: 'Graph', icon: GraphIcon },
  { key: 'tasks', label: 'Tasks', icon: TaskIcon },
  { key: 'calendar', label: 'Calendar', icon: CalendarIcon },
  { key: 'email', label: 'Email', icon: MailIcon },
  { key: 'agent', label: 'SeeMO', icon: AgentIcon },
  { key: 'misc', label: 'Misc', icon: MoreIcon },
  { key: 'settings', label: 'Settings', icon: SettingsIcon }
]

export const NAV_BY_KEY = Object.fromEntries(NAV_ITEMS.map((item) => [item.key, item])) as Record<
  NavKey,
  NavItem
>

export const NAV_LABELS = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.label])
) as Record<NavKey, string>

/**
 * Every nav page now renders as a dedicated full-size, tab-free view (like
 * Home and SeeMO) rather than floating above the notes. Kept as a helper so
 * the layout code has one place to reason about inline vs. tabbed notes.
 */
export function isInlineNav(key: NavKey | null): key is NavKey {
  return key !== null
}
