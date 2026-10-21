/**
 * Block-level markdown parsing shared by the renderer and the block editor.
 *
 * A "block" is one logical markdown construct: a heading, a run of list
 * items, a quote, a fenced code chunk, or a paragraph. Blocks are separated
 * by blank lines, which is what lets the editor treat the document as a list
 * of independently editable pieces (Notion-style) while keeping the rendered
 * output identical to the source.
 */

export const FENCE = /^\s*```/
export const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/
export const HEADING = /^(#{1,6})\s+(.*)$/
export const QUOTE = /^\s*>\s?(.*)$/
export const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
export const BULLET = /^\s*[-*+]\s+(.*)$/
export const ORDERED = /^\s*\d+\.\s+(.*)$/
export const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```)/

/**
 * Explicit block notation. A block is a run of markdown lines wrapped in
 * braces on their own lines:
 *
 *   {
 *   # Heading
 *   $$ E = mc^2 $$
 *   - [ ] revise
 *   }
 *
 * A single structural line may also be written compactly (`{ - [ ] revise }`).
 * Braces only act as delimiters when a matching close brace exists and the
 * marker itself is not inside a fenced code block.
 */
export const BLOCK_OPEN = /^\s*\{\s*$/
export const BLOCK_CLOSE = /^\s*\}\s*$/

/** One line that can live in a compact `{ … }` block. */
function compactableLine(line: string): boolean {
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    TASK.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    (line.startsWith('$$') && line.length > 4 && line.endsWith('$$'))
  )
}

/** Content of a compact one-line block (`{ - [ ] task }`), or null. */
export function compactBlockContent(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  const inner = trimmed.slice(1, -1).trim()
  if (!inner || !compactableLine(inner)) return null
  return inner
}

/** The compact form for a single-line block body, or null when not eligible. */
export function compactBlockLine(markdown: string): string | null {
  if (markdown.includes('\n') || !compactableLine(markdown)) return null
  return `{ ${markdown} }`
}

/**
 * Pair explicit block braces in a document. Fenced code is skipped so a `}`
 * inside a code sample never closes a block. Unpaired braces stay literal.
 */
export function scanBlockMarkers(lines: string[]): {
  opens: Set<number>
  closes: Set<number>
} {
  const opens = new Set<number>()
  const closes = new Set<number>()
  const fenced: boolean[] = []
  let inFence = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced.push(false)
      inFence = !inFence
      continue
    }
    fenced.push(!inFence)
  }
  for (let i = 0; i < lines.length; i++) {
    if (!fenced[i] || !BLOCK_OPEN.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && !(fenced[j] && BLOCK_CLOSE.test(lines[j]))) j++
    if (j >= lines.length) continue
    opens.add(i)
    closes.add(j)
    i = j
  }
  return { opens, closes }
}

/** Split a document into blank-line-separated markdown blocks. */
export function splitBlocks(source: string): string[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let i = 0

  while (i < lines.length) {
    // Blank lines only separate blocks — they are not content.
    while (i < lines.length && !lines[i].trim()) i++
    if (i >= lines.length) break

    const start = i

    if (FENCE.test(lines[i])) {
      // A fence swallows everything up to and including its closing marker.
      i++
      while (i < lines.length && !FENCE.test(lines[i])) i++
      if (i < lines.length) i++
    } else if (HEADING.test(lines[i]) || RULE.test(lines[i])) {
      i++
    } else if (TASK.test(lines[i]) || BULLET.test(lines[i])) {
      while (i < lines.length && (TASK.test(lines[i]) || BULLET.test(lines[i]))) i++
    } else if (ORDERED.test(lines[i])) {
      while (i < lines.length && ORDERED.test(lines[i])) i++
    } else if (QUOTE.test(lines[i])) {
      while (i < lines.length && QUOTE.test(lines[i])) i++
    } else {
      // Paragraph: consecutive plain lines.
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) i++
      if (i === start) i++
    }

    blocks.push(lines.slice(start, i).join('\n'))
  }

  return blocks.length > 0 ? blocks : ['']
}

/** Reassemble blocks into a document (one blank line between blocks). */
export function joinBlocks(blocks: string[]): string {
  return blocks.join('\n\n')
}
