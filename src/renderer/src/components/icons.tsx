import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number
}

function IconBase({ size = 24, children, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export function CalendarIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
    </IconBase>
  )
}

export function AgentIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 12v2" />
      <path d="M9 12v2" />
    </IconBase>
  )
}

/** Chat / SeeMO conversation bubble. */
export function ChatIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </IconBase>
  )
}

export function ActivityIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </IconBase>
  )
}

export function MoreIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </IconBase>
  )
}

/** Six-dot drag grip for reordering blocks. */
export function GripIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props} fill="currentColor" stroke="none">
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </IconBase>
  )
}

export function HomeIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </IconBase>
  )
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconBase>
  )
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </IconBase>
  )
}

export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </IconBase>
  )
}

export function FileTextIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </IconBase>
  )
}

export function PdfIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v5h5" />
      <path d="M8.5 17.5v-4h1.1a1.2 1.2 0 0 1 0 2.4H8.5" />
      <path d="M12.2 13.5H14a1.5 1.5 0 0 1 0 3h-1.8z" />
      <path d="M16.5 17.5v-4H18" />
      <path d="M16.5 15.6h1.2" />
    </IconBase>
  )
}

export function PencilIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </IconBase>
  )
}

export function XIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </IconBase>
  )
}

/** Push pin, used for pinned note tabs. */
export function PinIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </IconBase>
  )
}

export function SendIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m22 2-7 20-4-9-9-4z" />
      <path d="M22 2 11 13" />
    </IconBase>
  )
}

export function SettingsIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  )
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  )
}

export function ChevronUpIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m18 15-6-6-6 6" />
    </IconBase>
  )
}

export function ChevronLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m15 18-6-6 6-6" />
    </IconBase>
  )
}

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m9 18 6-6-6-6" />
    </IconBase>
  )
}

/** Notion-style "hide sidebar" («). */
export function PanelLeftCloseIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m11 17-5-5 5-5" />
      <path d="m18 17-5-5 5-5" />
    </IconBase>
  )
}

/** Notion-style "show sidebar" (»). */
export function PanelLeftOpenIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m13 17 5-5-5-5" />
      <path d="m6 17 5-5-5-5" />
    </IconBase>
  )
}

/** Notion-style sidebar toggle: window outline with a filled left panel. */
export function SidebarToggleIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path
        d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5z"
        fill="currentColor"
        stroke="none"
        opacity="0.35"
      />
    </IconBase>
  )
}

export function GraphIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="m8.2 7 7.3.7" />
      <path d="m7.2 8.2 3.6 7.2" />
      <path d="m16.8 10.1-3.2 5.6" />
    </IconBase>
  )
}

export function ImageIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 18 5-5 3.5 3.5 2.5-2.5 4 4" />
    </IconBase>
  )
}

export function CommandIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m5 7 5 5-5 5" />
      <path d="M13 17h6" />
    </IconBase>
  )
}

export function MailIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 7L22 7" />
    </IconBase>
  )
}

export function BookmarkIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </IconBase>
  )
}

export function RestoreIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M3 12a9 9 0 1 0 2.6-6.4" />
      <path d="M3 4v5h5" />
    </IconBase>
  )
}

export function SectionIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </IconBase>
  )
}

export function SplitIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </IconBase>
  )
}

export function ClearAllIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 5l6 6M10 5l-6 6" />
      <path d="M14 13l6 6M20 13l-6 6" />
    </IconBase>
  )
}

export function TaskIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </IconBase>
  )
}

export function AlarmIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 10v3l2 2" />
      <path d="M5 4 3 6" />
      <path d="m19 4 2 2" />
    </IconBase>
  )
}

export function TimerIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M6 2h12" />
      <path d="M6 22h12" />
      <path d="M8 2v4l4 4 4-4V2" />
      <path d="M8 22v-4l4-4 4 4v4" />
    </IconBase>
  )
}

export function StopwatchIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 10v3l2 2" />
      <path d="M9 2h6" />
      <path d="M12 2v4" />
    </IconBase>
  )
}

export function ExclamationIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </IconBase>
  )
}

export function VolumeIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.6 5.4a9 9 0 0 1 0 13.2" />
    </IconBase>
  )
}

export function VolumeMutedIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="m22 9-6 6" />
      <path d="m16 9 6 6" />
    </IconBase>
  )
}

export function MicIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
      <path d="M8 21h8" />
    </IconBase>
  )
}

export function MicMutedIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
      <path d="M8 21h8" />
      <path d="m3 3 18 18" />
    </IconBase>
  )
}

/** Flashcards: stacked study cards. */
export function CardsIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="3" y="6" width="13" height="13" rx="2" />
      <path d="M8 6V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1" />
      <path d="M7 11h6" />
      <path d="M7 15h4" />
    </IconBase>
  )
}

/** Eye: show events. */
export function EyeIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  )
}

/** Eye-off: hide events. */
export function EyeOffIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M17.94 17.94A10.5 10.5 0 0 1 12 19c-6.5 0-10-7-10-7a17.6 17.6 0 0 1 4.06-4.94" />
      <path d="M9.9 4.24A10.5 10.5 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
      <path d="m2 2 20 20" />
    </IconBase>
  )
}

/** Learn set: graduation cap. */
export function LearnIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m2 9 10-5 10 5-10 5z" />
      <path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5" />
      <path d="M22 9v5" />
    </IconBase>
  )
}

/** Mindmap: central node with branches. */
export function MindmapIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="5" r="1.8" />
      <circle cx="19" cy="5" r="1.8" />
      <circle cx="5" cy="19" r="1.8" />
      <circle cx="19" cy="19" r="1.8" />
      <path d="m10.2 10.2-3.4-3.4" />
      <path d="m13.8 10.2 3.4-3.4" />
      <path d="m10.2 13.8-3.4 3.4" />
      <path d="m13.8 13.8 3.4 3.4" />
    </IconBase>
  )
}

/** Quiz: checkbox list. */
export function QuizIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m4 6 1.5 1.5L8 5" />
      <path d="M12 5h8" />
      <path d="m4 12 1.5 1.5L8 11" />
      <path d="M12 11h8" />
      <path d="m4 18 1.5 1.5L8 17" />
      <path d="M12 17h8" />
    </IconBase>
  )
}

/** Profile: head and shoulders. */
export function UserIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </IconBase>
  )
}

/** Change user: a person with a circulating arrow. */
export function SwitchUserIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 8.2-4.9" />
      <path d="M17.5 4.5 20 7l-2.5 2.5" />
      <path d="M20 7h-5.2a4 4 0 0 0-3.6 2.2" />
    </IconBase>
  )
}

/** Log out: door with an outbound arrow. */
export function LogOutIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </IconBase>
  )
}
