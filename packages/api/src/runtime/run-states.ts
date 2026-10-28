import type { RuntimeClient } from "./runtime-client"
import type { SessionRunState } from "./types"

/** Subscribe before taking the initial snapshot; a late snapshot never replaces newer events. */
export function observeRunStates(
  port: Pick<RuntimeClient, "onRunStates" | "runStates">,
  apply: (sessions: SessionRunState[], source: "event" | "snapshot") => void
): { ready: Promise<void>; dispose: () => void } {
  let active = true
  let revision = 0
  let stop: (() => void) | undefined
  const dispose = () => {
    active = false
    const release = stop
    stop = undefined
    release?.()
  }
  const ready = (async () => {
    try {
      const release = await port.onRunStates((sessions) => {
        if (!active) return
        revision++
        apply(sessions, "event")
      })
      if (!active) {
        release()
        return
      }
      stop = release
      const baseline = revision
      const snapshot = await port.runStates()
      if (active && revision === baseline) apply(snapshot, "snapshot")
    } catch (error) {
      dispose()
      throw error
    }
  })()
  return { ready, dispose }
}
