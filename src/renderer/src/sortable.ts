import { useLayoutEffect, useRef, type DragEvent as ReactDragEvent, type RefObject } from 'react'

/**
 * Transform-based "make space" drag layer for the app's native DnD lists.
 *
 * The existing drop handlers still own every data change: this module only
 * paints a floating preview, shifts the rows around the insertion slot, and
 * draws the placeholder. Each list opts in with `data-sortable-list` on its
 * container and `data-sortable-item` / `data-sortable-id` on its direct
 * children, then calls `useSortableMakeSpace` once.
 */

const SHIFT_MS = 170
const DROP_MS = 150
const SHIFT_EASE = 'cubic-bezier(0.2, 0, 0, 1)'
const EDGE = 56
const MAX_SCROLL = 18
const PLACEHOLDER_CLASS = 'sortable-placeholder'
const PREVIEW_CLASS = 'sortable-drag-preview'

export interface SortableHint {
  id: string
  before: boolean
}

interface SortableOptions {
  rootRef: RefObject<HTMLElement | null>
  activeId: string | null
  hints: SortableHint[]
  enabled?: boolean
}

interface Baseline {
  rect: DOMRect
  left: number
  top: number
  width: number
  height: number
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface Group {
  id: string
  elements: HTMLElement[]
  rect: Box
  offset: Box
}

interface DragSession {
  id: string
  preview: HTMLElement
  activeEl: HTMLElement
  sourceRect: DOMRect
  offsetX: number
  offsetY: number
  targetRect: DOMRect | null
  dropped: boolean
  finishing: boolean
}

let session: DragSession | null = null
let transparentImage: HTMLElement | null = null
let autoScrollFrame: number | null = null
let autoPointer = { x: 0, y: 0 }
let hiddenElements: HTMLElement[] = []
let finishTimer: number | null = null
let dropTimer: number | null = null
const placeholders = new WeakMap<HTMLElement, HTMLElement>()

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function axisStart(rect: { left: number; top: number }, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.left : rect.top
}

function axisEnd(rect: { right: number; bottom: number }, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.right : rect.bottom
}

function axisSize(rect: { width: number; height: number }, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.width : rect.height
}

function crossStart(rect: { left: number; top: number }, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.top : rect.left
}

function unionRect(rects: Box[] | DOMRect[]): Box {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function baselineFor(
  el: HTMLElement,
  container: HTMLElement,
  cache: WeakMap<HTMLElement, Baseline>,
  containerRect: DOMRect
): Baseline {
  const cached = cache.get(el)
  if (cached) return cached
  const rect = el.getBoundingClientRect()
  const value: Baseline = {
    rect,
    left: rect.left - containerRect.left + container.scrollLeft,
    top: rect.top - containerRect.top + container.scrollTop,
    width: rect.width,
    height: rect.height
  }
  cache.set(el, value)
  return value
}

function groupFrom(
  id: string,
  elements: HTMLElement[],
  container: HTMLElement,
  cache: WeakMap<HTMLElement, Baseline>,
  containerRect: DOMRect
): Group {
  const baselines = elements.map((el) => baselineFor(el, container, cache, containerRect))
  const rect = unionRect(baselines.map((item) => item.rect))
  const offset = unionRect(
    baselines.map((item): Box => ({
      left: item.left,
      top: item.top,
      right: item.left + item.width,
      bottom: item.top + item.height,
      width: item.width,
      height: item.height
    }))
  )
  return { id, elements, rect, offset }
}

function placeholderFor(container: HTMLElement): HTMLElement {
  let el = placeholders.get(container)
  if (!el || !el.isConnected) {
    el = document.createElement('div')
    el.className = PLACEHOLDER_CLASS
    el.setAttribute('aria-hidden', 'true')
    container.appendChild(el)
    placeholders.set(container, el)
  }
  return el
}

function place(el: HTMLElement, shift: number, axis: 'x' | 'y'): void {
  el.style.removeProperty('opacity')
  el.style.removeProperty('pointer-events')
  el.style.transform =
    Math.abs(shift) < 0.5 ? '' : `translate${axis === 'x' ? 'X' : 'Y'}(${shift}px)`
}

function clearItemStyles(el: HTMLElement): void {
  el.style.removeProperty('transform')
  el.style.removeProperty('opacity')
  el.style.removeProperty('pointer-events')
  el.style.removeProperty('will-change')
}

function clearRoot(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-sortable-item]').forEach(clearItemStyles)
  root.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`).forEach((el) => el.remove())
}

function gapAround(groups: Group[], index: number, axis: 'x' | 'y'): number {
  const group = groups[index]
  if (!group) return 0
  const next = groups[index + 1]
  if (next) return Math.max(0, axisStart(next.rect, axis) - axisEnd(group.rect, axis))
  const prev = groups[index - 1]
  if (prev) return Math.max(0, axisStart(group.rect, axis) - axisEnd(prev.rect, axis))
  return 0
}

function paint(
  container: HTMLElement,
  cache: WeakMap<HTMLElement, Baseline>,
  activeId: string | null,
  hints: SortableHint[]
): void {
  const items = Array.from(container.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-sortable-id')
  )
  const placeholder = placeholders.get(container)
  if (placeholder) placeholder.style.display = 'none'
  if (items.length === 0) return

  const axis: 'x' | 'y' = container.dataset.sortableAxis === 'x' ? 'x' : 'y'
  const containerRect = container.getBoundingClientRect()
  const byId = new Map<string, HTMLElement[]>()
  for (const el of items) {
    const id = el.dataset.sortableId
    if (!id) continue
    const list = byId.get(id)
    if (list) list.push(el)
    else byId.set(id, [el])
  }
  const groups = [...byId.entries()].map(([id, elements]) =>
    groupFrom(id, elements, container, cache, containerRect)
  )

  const activeGroup = activeId ? (groups.find((group) => group.id === activeId) ?? null) : null
  let hintGroup: Group | null = null
  let hintBefore = false
  for (const hint of hints) {
    const found = groups.find((group) => group.id === hint.id)
    if (found) {
      hintGroup = found
      hintBefore = hint.before
      break
    }
  }
  if (!activeGroup && !hintGroup) {
    for (const group of groups) group.elements.forEach((el) => place(el, 0, axis))
    return
  }

  const globalActive = document.querySelector<HTMLElement>('[data-sortable-active="true"]')
  const activeRect = activeGroup?.rect ?? globalActive?.getBoundingClientRect() ?? hintGroup?.rect
  if (!activeRect) return
  const size = axisSize(activeRect, axis)

  if (activeGroup && !hintGroup) {
    const index = groups.indexOf(activeGroup)
    const step = size + gapAround(groups, index, axis)
    groups.forEach((group, i) => {
      if (group === activeGroup) return
      group.elements.forEach((el) => place(el, i > index ? -step : 0, axis))
    })
    return
  }

  if (!hintGroup) return

  const gap = gapAround(groups, groups.indexOf(hintGroup), axis)
  const step = size + gap

  if (activeGroup) {
    const activeIndex = groups.indexOf(activeGroup)
    const removed = groups.filter((group) => group !== activeGroup)
    const targetIndex = removed.indexOf(hintGroup)
    const insertAt = targetIndex + (hintBefore ? 0 : 1)
    groups.forEach((group, i) => {
      if (group === activeGroup) return
      const removedIndex = i > activeIndex ? i - 1 : i
      const base = i > activeIndex ? -step : 0
      const extra = removedIndex >= insertAt ? step : 0
      group.elements.forEach((el) => place(el, base + extra, axis))
    })
    let origin: number
    if (insertAt < removed.length) {
      const group = removed[insertAt]
      const shifted = groups.indexOf(group) > activeIndex ? -step : 0
      origin = axisStart(group.offset, axis) + shifted
    } else if (removed.length > 0) {
      const last = removed[removed.length - 1]
      const shifted = groups.indexOf(last) > activeIndex ? -step : 0
      origin = axisEnd(last.offset, axis) + shifted + gap
    } else {
      origin = axisStart(activeGroup.offset, axis)
    }
    drawPlaceholder(placeholderFor(container), origin, activeGroup, axis, size)
    return
  }

  const insertAt = groups.indexOf(hintGroup) + (hintBefore ? 0 : 1)
  groups.forEach((group, i) => {
    group.elements.forEach((el) => place(el, i >= insertAt ? step : 0, axis))
  })
  const origin =
    insertAt < groups.length
      ? axisStart(groups[insertAt].offset, axis)
      : axisEnd(groups[groups.length - 1].offset, axis) + gap
  drawPlaceholder(placeholderFor(container), origin, hintGroup, axis, size)
}

function drawPlaceholder(
  el: HTMLElement,
  origin: number,
  activeGroup: Group,
  axis: 'x' | 'y',
  size: number
): void {
  const globalActive = document.querySelector<HTMLElement>('[data-sortable-active="true"]')
  const rect = globalActive?.getBoundingClientRect() ?? activeGroup.rect
  const cross = crossStart(activeGroup.offset, axis)
  el.style.display = 'block'
  el.style.position = 'absolute'
  el.style.pointerEvents = 'none'
  el.style.left = `${axis === 'x' ? origin : cross}px`
  el.style.top = `${axis === 'x' ? cross : origin}px`
  el.style.width = `${axis === 'x' ? size : rect.width}px`
  el.style.height = `${axis === 'x' ? rect.height : size}px`
  el.style.zIndex = '1'
}

function onDragOver(event: DragEvent): void {
  if (!session || session.finishing) return
  // The first dragover proves the native drag is alive. Hiding the source
  // during `dragstart` can abort the drag in Electron.
  if (!session.activeEl.hasAttribute('data-sortable-active')) {
    session.activeEl.setAttribute('data-sortable-active', 'true')
  }
  autoPointer = { x: event.clientX, y: event.clientY }
  const x = event.clientX - session.offsetX
  const y = event.clientY - session.offsetY
  session.preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.02)`
}

function onDrop(event: DragEvent): void {
  if (!session || session.finishing) return
  session.dropped = true
  document.body.classList.add('sortable-committing')
  autoPointer = { x: event.clientX, y: event.clientY }
  const placeholder = Array.from(
    document.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
  ).find((el) => getComputedStyle(el).display !== 'none')
  if (placeholder) session.targetRect = placeholder.getBoundingClientRect()
  // `dragend` normally drives the landing animation, but a drop can re-render
  // the source node before the browser dispatches it. Finish from the drop
  // itself so a lost dragend can never leave the row hidden.
  if (dropTimer !== null) window.clearTimeout(dropTimer)
  dropTimer = window.setTimeout(() => {
    dropTimer = null
    finish()
  }, 0)
}

function hideDropped(id: string): void {
  if (hiddenElements.length > 0) return
  const selector = `[data-sortable-id="${CSS.escape(id)}"]`
  document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    el.setAttribute('data-sortable-hidden', 'true')
    hiddenElements.push(el)
  })
}

function finish(): void {
  const current = session
  if (!current || current.finishing) return
  const at = current.dropped && current.targetRect ? current.targetRect : current.sourceRect
  hideDropped(current.id)
  if (reducedMotion()) {
    cleanup()
    return
  }
  current.finishing = true
  current.preview.style.transition = `transform ${DROP_MS}ms ${SHIFT_EASE}, opacity ${DROP_MS}ms ease`
  current.preview.style.transform = `translate3d(${at.left}px, ${at.top}px, 0) scale(1)`
  current.preview.style.opacity = '0.92'
  if (finishTimer !== null) window.clearTimeout(finishTimer)
  finishTimer = window.setTimeout(() => {
    finishTimer = null
    cleanup()
  }, DROP_MS + 20)
}

function onDragEnd(): void {
  if (!session) return
  finish()
}

function cleanup(): void {
  const current = session
  session = null
  if (finishTimer !== null) {
    window.clearTimeout(finishTimer)
    finishTimer = null
  }
  if (dropTimer !== null) {
    window.clearTimeout(dropTimer)
    dropTimer = null
  }
  document.removeEventListener('dragover', onDragOver, true)
  document.removeEventListener('dragover', onAutoDragOver, true)
  document.removeEventListener('drop', onDrop, true)
  window.removeEventListener('dragend', onDragEnd, true)
  document.body.classList.remove('sortable-dragging', 'sortable-committing')
  stopAutoScroll()
  document.querySelectorAll<HTMLElement>('[data-sortable-active="true"]').forEach((el) => {
    el.removeAttribute('data-sortable-active')
  })
  document
    .querySelectorAll<HTMLElement>('[data-sortable-hidden="true"]')
    .forEach((el) => el.removeAttribute('data-sortable-hidden'))
  hiddenElements = []
  current?.preview.remove()
}

function onAutoDragOver(event: DragEvent): void {
  autoPointer = { x: event.clientX, y: event.clientY }
}

function scrollableAt(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y)
  while (el && el !== document.body) {
    if (el instanceof HTMLElement) {
      const style = getComputedStyle(el)
      const yScroll =
        /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1
      const xScroll =
        /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1
      if (yScroll || xScroll) return el
    }
    el = el.parentElement
  }
  return null
}

function autoScrollTick(): void {
  autoScrollFrame = null
  if (!session || session.finishing) return
  const el = scrollableAt(autoPointer.x, autoPointer.y)
  if (el) {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
      const speed = edgeSpeed(autoPointer.y - rect.top, rect.bottom - autoPointer.y)
      if (speed) el.scrollTop += speed
    }
    if (/(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      const speed = edgeSpeed(autoPointer.x - rect.left, rect.right - autoPointer.x)
      if (speed) el.scrollLeft += speed
    }
  }
  autoScrollFrame = requestAnimationFrame(autoScrollTick)
}

function edgeSpeed(nearStart: number, nearEnd: number): number {
  if (nearStart < EDGE) return -Math.ceil(((EDGE - nearStart) / EDGE) * MAX_SCROLL)
  if (nearEnd < EDGE) return Math.ceil(((EDGE - nearEnd) / EDGE) * MAX_SCROLL)
  return 0
}

function startAutoScroll(): void {
  if (autoScrollFrame !== null) return
  document.addEventListener('dragover', onAutoDragOver, true)
  autoScrollFrame = requestAnimationFrame(autoScrollTick)
}

function stopAutoScroll(): void {
  if (autoScrollFrame !== null) {
    cancelAnimationFrame(autoScrollFrame)
    autoScrollFrame = null
  }
  document.removeEventListener('dragover', onAutoDragOver, true)
}

function transparentDragImage(): HTMLElement {
  if (!transparentImage) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    canvas.style.position = 'fixed'
    canvas.style.left = '-10px'
    canvas.style.top = '-10px'
    canvas.style.opacity = '0'
    canvas.style.pointerEvents = 'none'
    document.body.appendChild(canvas)
    transparentImage = canvas
  }
  return transparentImage
}

function clonePreview(source: HTMLElement | HTMLElement[]): HTMLElement {
  const sources = Array.isArray(source) ? source : [source]
  let clone: HTMLElement
  if (sources.length === 1) {
    clone = sources[0].cloneNode(true) as HTMLElement
  } else {
    clone = document.createElement('div')
    for (const el of sources) clone.appendChild(el.cloneNode(true))
  }
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
  clone.removeAttribute('id')
  const strip = (el: Element): void => {
    el.removeAttribute('data-sortable-item')
    el.removeAttribute('data-sortable-id')
    el.removeAttribute('data-sortable-list')
    el.removeAttribute('data-sortable-axis')
    el.removeAttribute('data-sortable-active')
    el.removeAttribute('data-sortable-hidden')
  }
  strip(clone)
  clone.querySelectorAll('[data-sortable-item], [data-sortable-list]').forEach(strip)
  clone.classList.add(PREVIEW_CLASS)
  return clone
}

/**
 * Start the visual side of an existing native drag. Call from `onDragStart`
 * after the component has set its own drag state.
 */
export function beginSortableDrag(
  event: ReactDragEvent,
  activeElement: HTMLElement,
  previewSource: HTMLElement | HTMLElement[] = activeElement
): void {
  if (reducedMotion()) return
  cleanup()
  const id = activeElement.dataset.sortableId
  if (!id) return

  const sources = Array.isArray(previewSource) ? previewSource : [previewSource]
  const rects = sources.map((el) => el.getBoundingClientRect())
  const previewRect = unionRect(rects)
  const preview = clonePreview(previewSource)
  preview.style.width = `${previewRect.right - previewRect.left}px`
  preview.style.height = `${previewRect.bottom - previewRect.top}px`
  preview.style.transform = `translate3d(${previewRect.left}px, ${previewRect.top}px, 0) scale(1.02)`
  document.body.appendChild(preview)

  if (event.dataTransfer) {
    try {
      event.dataTransfer.setDragImage(transparentDragImage(), 0, 0)
    } catch {
      // Some Electron builds reject a canvas drag image; the native ghost is
      // an acceptable fallback for that frame.
    }
  }

  session = {
    id,
    preview,
    activeEl: activeElement,
    sourceRect: activeElement.getBoundingClientRect(),
    offsetX: event.clientX - previewRect.left,
    offsetY: event.clientY - previewRect.top,
    targetRect: null,
    dropped: false,
    finishing: false
  }
  document.body.classList.add('sortable-dragging')
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDrop, true)
  window.addEventListener('dragend', onDragEnd, true)
  startAutoScroll()
}

/** Cancel/cleanup immediately (used when a component unmounts mid-drag). */
export function endSortableDrag(): void {
  if (session) cleanup()
}

/** Shared shift duration for callers that want to match the preview drop. */
export const SORTABLE_SHIFT_MS = SHIFT_MS

export function useSortableMakeSpace({
  rootRef,
  activeId,
  hints,
  enabled = true
}: SortableOptions): void {
  const cacheRef = useRef<WeakMap<HTMLElement, Baseline> | null>(null)
  const dragRef = useRef<string | null>(null)
  const hintsKey = hints.map((hint) => `${hint.id}:${hint.before ? 1 : 0}`).join('|')

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (!enabled || reducedMotion()) {
      clearRoot(root)
      return
    }
    const hintList = hintsKey
      ? hintsKey.split('|').map((entry) => {
          const at = entry.lastIndexOf(':')
          return { id: entry.slice(0, at), before: entry.slice(at + 1) === '1' }
        })
      : []
    const active = activeId
    if (dragRef.current !== active) {
      dragRef.current = active
      cacheRef.current = new WeakMap()
    }
    const cache = cacheRef.current ?? new WeakMap<HTMLElement, Baseline>()
    cacheRef.current = cache

    root.querySelectorAll<HTMLElement>('[data-sortable-list]').forEach((container) => {
      paint(container, cache, active, hintList)
    })
  }, [rootRef, activeId, hintsKey, enabled])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    return () => clearRoot(root)
  }, [rootRef])
}
