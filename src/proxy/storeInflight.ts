interface StableStore {
  readonly refreshKey?: string
}

export interface StoreInflight<TStore extends object, TResult> {
  readonly byKey: Map<string, Promise<TResult>>
  readonly byStore: WeakMap<TStore, Promise<TResult>>
}

export function createStoreInflight<TStore extends object, TResult>(): StoreInflight<TStore, TResult> {
  return { byKey: new Map(), byStore: new WeakMap() }
}

export function runStoreOperationOnce<TStore extends object & StableStore, TResult>(
  store: TStore,
  inflight: StoreInflight<TStore, TResult>,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const refreshKey = store.refreshKey
  if (refreshKey) {
    const active = inflight.byKey.get(refreshKey)
    if (active) return active

    const started = operation().finally(() => {
      inflight.byKey.delete(refreshKey)
    })
    inflight.byKey.set(refreshKey, started)
    return started
  }

  const active = inflight.byStore.get(store)
  if (active) return active

  const started = operation().finally(() => {
    inflight.byStore.delete(store)
  })
  inflight.byStore.set(store, started)
  return started
}
