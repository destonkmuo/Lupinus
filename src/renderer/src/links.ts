/**
 * Link detection shared by the markdown renderer and the note editor.
 *
 * Accepts full URLs (`https://…`, `www.…`) and bare domains with a known TLD
 * (`x.com`, `docs.example.org/path`), so typing a domain automatically becomes
 * a link instead of requiring the user to add a scheme.
 */

const TLDS =
  'com|org|net|io|co|dev|ai|app|me|xyz|so|to|gg|tv|edu|gov|us|uk|ca|de|fr|jp|au|in|info|biz|site|online|store|blog|news|live|page|link|run|sh|cc'

/** One URL, without a leading boundary. */
export const URL_SOURCE = `(?:(?:https?:\\/\\/|www\\.)[^\\s<>()\\[\\]]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?::\\d+)?(?:[/?#][^\\s<>()\\[\\]]*)?)`

/** Global matcher for URLs inside a plain-text run. */
export const URL_RE = new RegExp(`(?<![\\w@.-])${URL_SOURCE}`, 'gi')

/** The most recent URL, assuming it ended the text (usually before a space). */
const URL_AT_END_RE = new RegExp(`(?:^|[\\s([<"'])(${URL_SOURCE})$`, 'i')

/** The entire text is a single URL. */
const URL_ONLY_RE = new RegExp(`^\\s*(${URL_SOURCE})\\s*$`, 'i')

/** Strip trailing sentence punctuation that belongs to the prose, not the URL. */
export function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, '').replace(/[)\]]+$/, '')
}

/** Turn a detected URL into an href, adding https:// when no scheme is given. */
export function normalizeUrl(raw: string): string | undefined {
  const url = trimUrl(raw.trim())
  if (!url) return undefined
  if (/^javascript:/i.test(url)) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  return `https://${url}`
}

/** Split plain text into text and URL segments (URLs are pre-trimmed). */
export function splitLinks(text: string): { value: string; url: boolean }[] {
  const parts: { value: string; url: boolean }[] = []
  let last = 0
  URL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_RE.exec(text)) !== null) {
    const start = match.index + match[0].indexOf(match[1] ?? match[0])
    const raw = match[1] ?? match[0]
    const trimmed = trimUrl(raw)
    if (!trimmed) continue
    if (start > last) parts.push({ value: text.slice(last, start), url: false })
    parts.push({ value: trimmed, url: true })
    last = start + trimmed.length
  }
  if (last < text.length) parts.push({ value: text.slice(last), url: false })
  return parts
}

/** A URL that ends exactly at the end of `text` (trailing whitespace allowed). */
export function urlAtEnd(text: string): { raw: string; start: number } | null {
  const trimmedEnd = text.replace(/\s+$/, '')
  const match = URL_AT_END_RE.exec(trimmedEnd)
  if (!match) return null
  const raw = match[1]
  return { raw, start: trimmedEnd.length - raw.length }
}

/** A whole pasted string that is just a URL. */
export function urlOnly(text: string): string | null {
  const match = URL_ONLY_RE.exec(text)
  return match ? match[1] : null
}
