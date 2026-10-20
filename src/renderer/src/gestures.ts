/** A sidebar space swipe owns the horizontal gesture for a short window, so
 * the same trackpad motion can never also step page history. */
let spaceSwipeUntil = 0

export function markSpaceSwipe(): void {
  spaceSwipeUntil = performance.now() + 700
}

export function isSpaceSwipeActive(): boolean {
  return performance.now() < spaceSwipeUntil
}
