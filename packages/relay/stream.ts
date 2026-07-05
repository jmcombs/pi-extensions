/**
 * stream.ts — a minimal, self-contained async event stream that mirrors pi-ai's
 * `AssistantMessageEventStream` runtime contract.
 *
 * WHY hand-rolled instead of `createAssistantMessageEventStream` from
 * `@earendil-works/pi-ai/compat`: in this monorepo the root-hoisted `pi-ai` does
 * not expose the `./compat` subpath (only the copy nested under
 * `pi-coding-agent`, which pi loads at runtime, does). Importing it directly from
 * this package therefore fails typecheck. We instead reproduce the exact contract
 * the pi agent loop relies on — `for await (const event of stream)` plus
 * `await stream.result()` (see pi-agent-core `agent-loop.js` `streamAssistantResponse`).
 *
 * The provider casts an instance of this class to pi's stream type; the consumer
 * never inspects private fields or uses `instanceof`, so the structural contract
 * below is sufficient.
 */

/** A stream event. Terminal events are `{ type: "done", message }` / `{ type: "error", error }`. */
export interface RelayStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** Async-iterable event stream with a resolvable final result. */
export class RelayEventStream<TEvent extends RelayStreamEvent, TResult> {
  private readonly queue: TEvent[] = [];
  private readonly waiting: ((result: IteratorResult<TEvent>) => void)[] = [];
  private done = false;
  private readonly finalPromise: Promise<TResult>;
  private resolveFinal!: (value: TResult) => void;

  constructor(
    private readonly isTerminal: (event: TEvent) => boolean,
    private readonly extractResult: (event: TEvent) => TResult,
  ) {
    this.finalPromise = new Promise<TResult>((resolve) => {
      this.resolveFinal = resolve;
    });
  }

  /** Push an event. A terminal event resolves `result()` and closes the stream. */
  push(event: TEvent): void {
    if (this.done) return;
    if (this.isTerminal(event)) {
      this.done = true;
      this.resolveFinal(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<TEvent>>((resolve) => {
          this.waiting.push(resolve);
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }

  /** Resolves with the final result once a terminal event is pushed. */
  result(): Promise<TResult> {
    return this.finalPromise;
  }
}
