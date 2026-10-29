import { useMemo, useState } from 'react'
import { documentHeadings } from '../notes'
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from './icons'

interface DocumentTabsProps {
  /** Note body markdown (hidden footer already stripped). */
  content: string
  /** Index of the heading currently in view, or -1 near the top. */
  activeIndex: number
  onSelect: (index: number) => void
}

/**
 * Google-Docs-style sections outline: generated from the note's headings.
 * Nothing has to be created by hand — typing `# Heading` adds an entry here
 * immediately, indented by heading level.
 */
function DocumentTabs({ content, activeIndex, onSelect }: DocumentTabsProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const items = useMemo(() => documentHeadings(content), [content])

  return (
    <>
      {/* Fully collapsed panels leave no rail, so this floating handle is the
          only way back. It sits in the document's left gutter. */}
      {collapsed && (
        <button
          type="button"
          className="doctabs__reveal"
          title="Show sections"
          aria-label="Show sections"
          onClick={() => setCollapsed(false)}
        >
          <PanelLeftOpenIcon size={15} />
        </button>
      )}

      <aside className={`doctabs${collapsed ? ' doctabs--collapsed' : ''}`} aria-label="Sections">
        <div className="doctabs__inner">
          <div className="doctabs__head">
            <span className="doctabs__title">Sections</span>
            <button
              type="button"
              className="doctabs__toggle"
              title="Hide sections"
              aria-label="Hide sections"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(true)}
            >
              <PanelLeftCloseIcon size={15} />
            </button>
          </div>

          <div className="doctabs__list">
            {items.length > 0 ? (
              <div className="doctabs__outline">
                {items.map((item, index) => (
                  <button
                    key={`${index}-${item.text}`}
                    type="button"
                    className={`doctabs__item${index === activeIndex ? ' is-active' : ''}`}
                    style={{
                      paddingLeft: `${6 + (item.level - 1) * 12}px`,
                      paddingRight: `${6 + (item.level - 1) * 12}px`
                    }}
                    title={item.text || 'Untitled heading'}
                    onClick={() => onSelect(index)}
                  >
                    {item.text || 'Untitled heading'}
                  </button>
                ))}
              </div>
            ) : (
              <p className="doctabs__empty">
                Add headings to your note and they&apos;ll appear here automatically.
              </p>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

export default DocumentTabs
