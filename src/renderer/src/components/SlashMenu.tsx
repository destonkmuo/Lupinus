import { filteredSlash, type SlashCommand } from '../slash'

/**
 * The `/` insert menu, floated under the active block. Shared by the plain
 * markdown textarea and the rich (formatted) inline editor.
 */
function SlashMenu({
  token,
  selected,
  fixedAt,
  onHover,
  onPick
}: {
  token: string
  selected: number
  /** Viewport position for editors whose caret can be anywhere on the page. */
  fixedAt?: { x: number; y: number }
  onHover: (index: number) => void
  onPick: (cmd: SlashCommand) => void
}): React.JSX.Element {
  const items = filteredSlash(token)
  const safe = items.length === 0 ? 0 : selected % items.length
  return (
    <div
      className="slash-menu"
      role="listbox"
      aria-label="Insert block"
      style={
        fixedAt ? { position: 'fixed', left: fixedAt.x, top: fixedAt.y, zIndex: 200 } : undefined
      }
    >
      {items.length === 0 ? (
        <p className="slash-menu__empty">No matches</p>
      ) : (
        items.map((cmd, i) => (
          <button
            key={cmd.id}
            type="button"
            role="option"
            aria-selected={i === safe}
            className={`slash-menu__item${i === safe ? ' is-selected' : ''}`}
            // mousedown default would blur the editable (closing edit mode)
            // before click fires; prevent it so picking keeps the caret.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(cmd)}
            onMouseEnter={() => onHover(i)}
          >
            <span className="slash-menu__badge" aria-hidden="true">
              {cmd.badge}
            </span>
            <span className="slash-menu__title">{cmd.title}</span>
            <span className="slash-menu__hint">{cmd.hint}</span>
          </button>
        ))
      )}
    </div>
  )
}

export default SlashMenu
