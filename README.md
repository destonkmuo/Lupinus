# Lupinus

A desktop notes app built with Electron, React, and TypeScript. Notes live as
plain Markdown files in a local vault, with tabs, dockable images, tasks, a
calendar, and a voice-driven assistant.

## Features

- **Block notes** — every note is a stack of blocks: paragraphs, checklists,
  quotes, code, math (KaTeX), and images.
- **Dockable images** — drag & drop or paste pictures in, unlock them to dock
  left / center / right with text wrapping, drag to move them between blocks.
- **Tabs & groups** — browser-style tabs with back/forward history, split view,
  and color-coded tab groups.
- **Collapsible sidebar** — Notion-style toggle, `Ctrl`/`Cmd` + `S` to
  show/hide, width persists across sessions.
- **Spotlight search** — `Ctrl`/`Cmd` + `T` to fuzzy-search notes,
  tasks, pages, and commands.
- **Tasks & calendar** — todos with due dates, a month view, local + subscribed
  calendars, and reminders with sound.
- **Graph view** — `[[wikilinks]]` between notes rendered as a knowledge graph.
- **Light, dark, and system-synced themes** — switch in Settings.
- **Voice assistant** — push-to-talk orb with transcripts, TTS replies, and an
  agentic core that can read and edit your notes.
- **Local-first vault** — everything is stored under `~/Documents/Lupinus` as
  `.md` + `.json`, with optional GitHub sync.

## Shortcuts

| Keys                      | Action                        |
| ------------------------- | ----------------------------- |
| `Ctrl`/`Cmd` + `S`        | Toggle sidebar                |
| `Ctrl`/`Cmd` + `T`          | Spotlight search              |
| `Ctrl` + `Tab`            | Tab switcher                  |
| `Shift` + `Enter`         | Split block while editing     |
| `Esc`                     | Leave editing / close overlay |

## Project setup

Requires Node.js 18+.

```bash
npm install
```

```bash
npm run dev      # start in development mode
npm run build    # typecheck + production build
```

Package installers per OS:

```bash
npm run build:mac    # macOS (.dmg)
npm run build:win    # Windows
npm run build:linux  # Linux
```

## Quality gates

```bash
npm run typecheck   # tsc for main + renderer
npm run lint        # eslint
npm run format      # prettier
```

## Recommended IDE setup

[VSCode](https://code.visualstudio.com/) +
[ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) +
[Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
