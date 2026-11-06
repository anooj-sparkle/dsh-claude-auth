/**
 * Small runtime helpers shared by the bridge modules.
 * @module dsh-llm-claude-code/util
 */

import { createHash } from 'node:crypto'

/** Stable short digest of arbitrary JSON-serializable data. */
export function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 24)
}

/**
 * Unbounded single-consumer queue that turns pushed values into awaited
 * reads. `end()` makes every later read resolve `undefined` once buffered
 * values are drained; `fail()` makes it reject instead.
 */
export class AsyncQueue<T> {
  private buffer: T[] = []
  private waiter: { resolve: (value: T | undefined) => void; reject: (error: unknown) => void } | undefined
  private ended = false
  private error: unknown

  push(value: T): void {
    if (this.ended) return
    if (this.waiter !== undefined) {
      const { resolve } = this.waiter
      this.waiter = undefined
      resolve(value)
      return
    }
    this.buffer.push(value)
  }

  end(error?: unknown): void {
    if (this.ended) return
    this.ended = true
    this.error = error
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      if (error === undefined) waiter.resolve(undefined)
      else waiter.reject(error)
    }
  }

  get isEnded(): boolean {
    return this.ended
  }

  /** Values buffered and not yet read. */
  get size(): number {
    return this.buffer.length
  }

  /**
   * Read the next value.
   * @param signal - aborts the wait (the value stays queued).
   * @param timeoutMs - optional bound; resolves `undefined` with `timedOut` set.
   */
  next(signal?: AbortSignal, timeoutMs?: number): Promise<T | undefined> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift() as T)
    if (this.ended) return this.error === undefined ? Promise.resolve(undefined) : Promise.reject(this.error)
    if (this.waiter !== undefined) return Promise.reject(new Error('AsyncQueue supports a single reader'))
    return new Promise<T | undefined>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        this.waiter = undefined
        cleanup()
        reject(signal?.reason ?? new Error('aborted'))
      }
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiter = undefined
          cleanup()
          resolve(undefined)
        }, timeoutMs)
      }
      this.waiter = {
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
      }
    })
  }
}
