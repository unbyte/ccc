import type { AnthropicMessageStreamEvent } from '../protocol/anthropic-messages'

/** Async listener for transformed Anthropic stream events. */
export type StreamResponderListener = (event: AnthropicMessageStreamEvent) => void | Promise<void>

/** Awaitable, ordered event source used by response transformers. */
export abstract class StreamResponder<TInput> {
  private listeners: StreamResponderListener[] = []
  private processing = false
  private finished = false

  /** Registers a listener and returns an idempotent unsubscribe callback. */
  on(listener: StreamResponderListener) {
    this.listeners.push(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  /** Processes one input and rejects concurrent or post-completion pushes. */
  async push(input: TInput) {
    if (this.finished) throw new Error('Cannot push after the response transformer has finished')
    if (this.processing) throw new Error('Concurrent response transformer pushes are not allowed')
    this.processing = true
    try {
      await this.process(input)
    } finally {
      this.processing = false
    }
  }

  /** Completes the input lifecycle once; subclasses validate terminal state. */
  async finish() {
    if (this.finished) return
    if (this.processing) throw new Error('Cannot finish while a response event is being processed')
    this.processing = true
    try {
      await this.complete()
      this.finished = true
    } finally {
      this.processing = false
    }
  }

  /** Emits to a stable listener snapshot sequentially and awaits backpressure. */
  protected async emit(event: AnthropicMessageStreamEvent) {
    for (const listener of [...this.listeners]) await listener(event)
  }

  /** Converts one source event. */
  protected abstract process(input: TInput): Promise<void>

  /** Validates and closes the source lifecycle. */
  protected abstract complete(): Promise<void>
}
