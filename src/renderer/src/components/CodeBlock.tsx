import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'

/** Single-threaded only: runs on the iframe's main thread, no workers. */
const RUN_TIMEOUT_MS = 5000

/** Fence languages that execute in the sandboxed runner page. */
function isRunnable(lang: string): boolean {
  return lang === 'js' || lang === 'javascript' || lang === 'jsx'
}

/**
 * Fenced code block with syntax highlighting (~40 languages via highlight.js)
 * and, for JavaScript, a Run button plus its own console.
 *
 * Execution happens in `runner.html` inside `<iframe sandbox="allow-scripts">`:
 * an opaque origin with no DOM, storage, or Electron access. Code travels by
 * postMessage (so it never needs escaping), console methods are captured, and
 * a timeout drops the frame if a script hangs. Each block owns its iframe, so
 * consoles never mix.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }): React.JSX.Element {
  const language = lang.trim().toLowerCase()
  const runnable = isRunnable(language)

  const [output, setOutput] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [frameKey, setFrameKey] = useState(0)

  const runIdRef = useRef(0)
  const armedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language }).value
      } catch {
        return null
      }
    }
    return null
  }, [code, language])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { source?: unknown; id?: unknown; lines?: unknown } | null
      if (!data || data.source !== 'lupinus-run' || data.id !== runIdRef.current) return
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setOutput(Array.isArray(data.lines) ? data.lines.map(String) : [])
      setRunning(false)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    },
    []
  )

  const run = (): void => {
    runIdRef.current += 1
    armedRef.current = true
    setOutput([])
    setRunning(true)
    // Fresh iframe kills any previous run still executing in this block.
    setFrameKey((key) => key + 1)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      armedRef.current = false
      setRunning(false)
      setOutput((prev) => [...prev, 'Timed out after 5 s — the script was stopped.'])
      // Drop the hung frame so it can never report back late.
      setFrameKey((key) => key + 1)
    }, RUN_TIMEOUT_MS)
  }

  // The runner page posts back only after we hand it code; the initial load
  // (and the post-timeout replacement) stays silent via the armed guard.
  const onFrameLoad = (): void => {
    if (!armedRef.current) return
    armedRef.current = false
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'lupinus-exec', id: runIdRef.current, code },
      '*'
    )
  }

  const copy = (): void => {
    try {
      const done = (): void => {
        setCopied(true)
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200)
      }
      const result = navigator.clipboard?.writeText(code)
      if (result) {
        void result.then(done, done)
      } else {
        done()
      }
    } catch {
      setCopied(false)
    }
  }

  // Only the interactive chrome (header buttons, console) swallows clicks:
  // Go/Copy must not bubble to the block editor's view container, which
  // would swap this block into edit mode and unmount the runner iframe
  // mid-run. Clicks on the code itself still bubble through so the block
  // stays editable.
  const swallowClick = (event: React.MouseEvent): void => event.stopPropagation()

  return (
    <div className="codeblock">
      <div className="codeblock__head" onClick={swallowClick}>
        <span className="codeblock__lang">{language || 'text'}</span>
        <span className="codeblock__actions">
          <button type="button" className="codeblock__btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {runnable && (
            <button
              type="button"
              className="codeblock__btn codeblock__btn--run"
              onClick={run}
              disabled={running}
              title="Run this block — output lands in its console below"
            >
              {running ? 'Running…' : 'Go'}
            </button>
          )}
        </span>
      </div>
      <pre className="codeblock__pre">
        {highlighted !== null ? (
          <code
            className={`hljs language-${language}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code>{code}</code>
        )}
      </pre>
      {runnable && (
        <div
          className="codeblock__console"
          aria-label="Console output"
          aria-live="polite"
          onClick={swallowClick}
        >
          {output.length === 0 ? (
            <span className="codeblock__console-empty">
              {running ? 'Running…' : 'Console output will appear here.'}
            </span>
          ) : (
            output.map((line, index) => (
              <div key={index} className="codeblock__console-line">
                {line}
              </div>
            ))
          )}
        </div>
      )}
      {runnable && (
        <iframe
          key={frameKey}
          ref={iframeRef}
          src="runner.html"
          sandbox="allow-scripts"
          title="JavaScript runner"
          aria-hidden="true"
          tabIndex={-1}
          className="codeblock__frame"
          onLoad={onFrameLoad}
        />
      )}
    </div>
  )
}

export default CodeBlock
