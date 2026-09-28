import type { SseEvent } from '@zeropoint/types';

/** Bound on buffered, not-yet-terminated text (SRS 2.3: no large in-memory structures). */
export const DEFAULT_MAX_BUFFER_CHARS = 1024 * 1024;

/**
 * Incremental Server-Sent Events decoder (FR-2.2).
 *
 * Feed it raw bytes as they arrive with `push()`; it returns every event that
 * became complete. It copes with:
 *  - frames split across chunks at ANY byte offset (including inside a
 *    multi-byte UTF-8 character: `TextDecoder` runs with `stream: true`),
 *  - several frames in one chunk,
 *  - `\n`, `\r\n` and lone `\r` line endings (a `\r` at the very end of a chunk
 *    waits for the next chunk, in case a `\n` follows),
 *  - `:` comment lines (keep-alives), multi-line `data:`, `event:` names,
 *  - a final frame that is missing its blank-line terminator (`end()`).
 *
 * Deliberate deviation from the SSE spec: the spec discards an unterminated
 * frame at EOF; `end()` delivers it, because a lost final frame would mean lost
 * usage accounting.
 *
 * Only the bytes of frames still being assembled are retained; once a frame is
 * returned nothing about it is kept, so no prompt/output text accumulates
 * (NFR-5.2). A single line longer than `maxBufferChars` is dropped (`overflowed`
 * is set) instead of growing memory without bound.
 */
export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private discarding = false;
  /** Chars at the front of `buffer` already known to hold no line terminator (avoids rescanning). */
  private scanned = 0;
  private eventName: string | null = null;
  private dataLines: string[] = [];
  private dataChars = 0;
  /** True if any oversized line or frame had to be dropped. */
  overflowed = false;

  constructor(private readonly maxBufferChars = DEFAULT_MAX_BUFFER_CHARS) {}

  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** Call once when the stream ends: flushes the decoder and any unterminated frame. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drain(true);
    if (this.buffer !== '' && !this.discarding) this.processLine(this.buffer);
    this.buffer = '';
    this.scanned = 0;
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    let from = this.scanned;
    for (;;) {
      const buf = this.buffer;
      let i = Math.max(start, from);
      from = 0;
      while (i < buf.length && buf.charCodeAt(i) !== 10 && buf.charCodeAt(i) !== 13) i++;
      if (i >= buf.length) {
        this.scanned = buf.length - start; // no complete line yet
        break;
      }
      const isCr = buf.charCodeAt(i) === 13;
      if (isCr && i === buf.length - 1 && !final) {
        this.scanned = i - start; // "\r" might be the start of "\r\n"
        break;
      }
      const line = buf.slice(start, i);
      start = i + (isCr && buf.charCodeAt(i + 1) === 10 ? 2 : 1);
      if (this.discarding) {
        this.discarding = false; // the oversized line ended; resume normally
        continue;
      }
      if (line === '') {
        const event = this.dispatch();
        if (event) events.push(event);
      } else {
        this.processLine(line);
      }
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = '';
      this.scanned = 0;
      this.discarding = true;
      this.overflowed = true;
    }
    return events;
  }

  private processLine(line: string): void {
    if (line.charCodeAt(0) === 58) return; // ":" comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'data') {
      if (this.dataChars + value.length > this.maxBufferChars) {
        this.overflowed = true;
        return;
      }
      this.dataLines.push(value);
      this.dataChars += value.length;
    } else if (field === 'event') {
      this.eventName = value;
    }
    // `id`, `retry` and unknown fields are irrelevant to usage extraction.
  }

  private dispatch(): SseEvent | null {
    const hasData = this.dataLines.length > 0;
    const event: SseEvent | null = hasData
      ? { event: this.eventName, data: this.dataLines.join('\n') }
      : null;
    this.eventName = null;
    this.dataLines = [];
    this.dataChars = 0;
    return event;
  }
}
