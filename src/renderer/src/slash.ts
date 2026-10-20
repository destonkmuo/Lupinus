/**
 * `/` insert-menu definitions shared by the block editor and the rich
 * (formatted) inline editor. Kept free of React so both surfaces can agree on
 * the command set without importing each other.
 */

/** A subpage that lives within its parent note as an individual child. */
export type ChildKind = 'page' | 'flashcards' | 'mindmap' | 'quiz'

export interface SlashCommand {
  id: string
  title: string
  badge: string
  hint: string
  keywords: string
  /** Skeleton to insert; `|` marks where the caret lands. Empty for actions. */
  insert: string
  /** Child-page action: creates a JSON/markdown child + embeds its link. */
  childKind?: ChildKind
}

/**
 * `/` menu: inserts raw markdown skeletons (still saved as `$…$`, ```, …),
 * so the document stays plain text under the WYSIWYG surface.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'h1', title: 'Heading 1', badge: 'H1', hint: '#', keywords: 'title header', insert: '# |' },
  {
    id: 'h2',
    title: 'Heading 2',
    badge: 'H2',
    hint: '##',
    keywords: 'title header',
    insert: '## |'
  },
  {
    id: 'h3',
    title: 'Heading 3',
    badge: 'H3',
    hint: '###',
    keywords: 'title header',
    insert: '### |'
  },
  {
    id: 'bullet',
    title: 'Bullet list',
    badge: '•',
    hint: '-',
    keywords: 'unordered point',
    insert: '- |'
  },
  {
    id: 'numbered',
    title: 'Numbered list',
    badge: '1.',
    hint: '1.',
    keywords: 'ordered',
    insert: '1. |'
  },
  {
    id: 'todo',
    title: 'To-do',
    badge: '☐',
    hint: '- [ ]',
    keywords: 'checkbox task check',
    insert: '- [ ] |'
  },
  { id: 'quote', title: 'Quote', badge: '>', hint: '>', keywords: 'cite callout', insert: '> |' },
  {
    id: 'divider',
    title: 'Divider',
    badge: '—',
    hint: '---',
    keywords: 'separator rule hr',
    insert: '---'
  },
  {
    id: 'code',
    title: 'Code block',
    badge: '{}',
    hint: '```js',
    keywords: 'snippet javascript runnable',
    insert: '```js\n|\n```'
  },
  {
    id: 'math',
    title: 'Math inline',
    badge: '∑',
    hint: '$…$',
    keywords: 'formula latex equation',
    insert: '$|$'
  },
  {
    id: 'mathblock',
    title: 'Math block',
    badge: '$$',
    hint: '$$…$$',
    keywords: 'display formula latex equation',
    insert: '$$\n|\n$$'
  },
  {
    id: 'image',
    title: 'Image',
    badge: 'img',
    hint: '![](url)',
    keywords: 'picture photo embed',
    insert: '![](|)'
  },
  {
    id: 'link',
    title: 'Link',
    badge: '[]',
    hint: '[text](url)',
    keywords: 'url href anchor',
    insert: '[|](url)'
  },
  {
    id: 'page',
    title: 'New page',
    badge: '+',
    hint: 'create',
    keywords: 'new page note document create subpage child link embed',
    insert: '',
    childKind: 'page'
  },
  {
    id: 'flashcards',
    title: 'New flashcards',
    badge: '[]',
    hint: 'create',
    keywords: 'new flashcards deck study learn cards terms definitions child link embed',
    insert: '',
    childKind: 'flashcards'
  },
  {
    id: 'mindmap',
    title: 'New mindmap',
    badge: 'M',
    hint: 'create',
    keywords: 'new mindmap branches nodes child link embed',
    insert: '',
    childKind: 'mindmap'
  },
  {
    id: 'quiz',
    title: 'New quiz',
    badge: '?',
    hint: 'create',
    keywords: 'new quiz test blank child link embed',
    insert: '',
    childKind: 'quiz'
  }
]

/**
 * Slash token before the caret on the current line (`/ma` in `hi /ma`),
 * or null. The char before `/` must be start/whitespace so `a/b` and
 * `https://` never open the menu.
 */
export const slashToken = (value: string, caret: number): string | null => {
  const before = value.slice(0, caret)
  const line = before.slice(before.lastIndexOf('\n') + 1)
  const match = /(^|\s)\/([\w-]*)$/.exec(line)
  return match ? match[2] : null
}

export const filteredSlash = (token: string): SlashCommand[] => {
  const needle = token.toLowerCase()
  if (!needle) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.id.toLowerCase().includes(needle) ||
      cmd.title.toLowerCase().includes(needle) ||
      cmd.keywords.includes(needle)
  )
}
