/**
 * Small runtime helpers shared by the bridge modules.
 * @module dsh-llm-claude-code/util
 */
/** Stable short digest of arbitrary JSON-serializable data. */
export declare function digest(value: unknown): string;
/**
 * Unbounded single-consumer queue that turns pushed values into awaited
 * reads. `end()` makes every later read resolve `undefined` once buffered
 * values are drained; `fail()` makes it reject instead.
 */
export declare class AsyncQueue<T> {
    private buffer;
    private waiter;
    private ended;
    private error;
    push(value: T): void;
    end(error?: unknown): void;
    get isEnded(): boolean;
    /** Values buffered and not yet read. */
    get size(): number;
    /**
     * Read the next value.
     * @param signal - aborts the wait (the value stays queued).
     * @param timeoutMs - optional bound; resolves `undefined` with `timedOut` set.
     */
    next(signal?: AbortSignal, timeoutMs?: number): Promise<T | undefined>;
}
