// A framework-agnostic store with zustand's vanilla surface (`getState` / `setState` / `subscribe` /
// `getInitialState`), so React bindings can hand it to `useStore` unchanged and Node callers need no
// React. The client publishes every state change through one of these.

export type StateSetter<T> = Partial<T> | ((state: T) => Partial<T>)

export interface Store<T extends object> {
  getState(): T
  getInitialState(): T
  /** Shallow-merges the partial (or the partial a function returns) into the current state; a no-op when nothing changed. */
  setState(partial: StateSetter<T>, replace?: boolean): void
  subscribe(listener: (state: T, previous: T) => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<(state: T, previous: T) => void>()
  return {
    getState: () => state,
    getInitialState: () => initial,
    setState(partial, replace = false) {
      const next = typeof partial === "function" ? partial(state) : partial
      if (next === undefined || next === null) return
      const previous = state
      state = replace ? (next as T) : { ...state, ...next }
      let changed = replace
      if (!changed)
        for (const key of Object.keys(next) as Array<keyof T>) if (!Object.is(previous[key], state[key])) changed = true
      if (!changed) {
        state = previous
        return
      }
      for (const listener of [...listeners]) listener(state, previous)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
