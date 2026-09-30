/**
 * One request signal that carries both deadlines and the caller's cancellation.
 * DSH asserts that a tool declaring a timeout forwards the caller's signal, and a
 * run that the user cancels should stop spending on the very next call rather
 * than at the next step boundary.
 */
export function requestSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  return outer ? AbortSignal.any([outer, deadline]) : deadline
}
