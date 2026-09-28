import { SseParser } from '@zeropoint/providers';
import type { SseEvent } from '@zeropoint/types';
import { describe, expect, it } from 'vitest';

const enc = new TextEncoder();

/** Feeds the given byte chunks through a fresh parser, then ends it. */
function parseAll(chunks: Uint8Array[], parser = new SseParser()): SseEvent[] {
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return events;
}

/** Multi-byte characters (2, 3 and 4 bytes) so byte-level splits land inside them. */
const TEXT =
  ': keep-alive\n\n' +
  'data: {"a":1}\n\n' +
  'event: message_start\ndata: {"b":"héllo ✓ 🚀"}\n\n' +
  'data: line1\ndata: line2\n\n' +
  'data: [DONE]\n\n';

const EXPECTED: SseEvent[] = [
  { event: null, data: '{"a":1}' },
  { event: 'message_start', data: '{"b":"héllo ✓ 🚀"}' },
  { event: null, data: 'line1\nline2' },
  { event: null, data: '[DONE]' },
];

/** Small deterministic PRNG so the "random" chunkings are reproducible. */
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomSplit(bytes: Uint8Array, next: () => number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const size = 1 + Math.floor(next() * 12);
    chunks.push(bytes.slice(i, i + size));
    i += size;
  }
  return chunks;
}

describe('SseParser (FR-2.2)', () => {
  it('decodes several events delivered in one chunk', () => {
    expect(parseAll([enc.encode(TEXT)])).toEqual(EXPECTED);
  });

  it('gives the same result when the stream is split at EVERY byte offset (events split across chunks)', () => {
    const bytes = enc.encode(TEXT);
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(parseAll([bytes.slice(0, cut), bytes.slice(cut)]), `cut at ${cut}`).toEqual(EXPECTED);
    }
  });

  it('gives the same result one byte at a time (splits inside multi-byte characters)', () => {
    const bytes = enc.encode(TEXT);
    expect(parseAll(Array.from(bytes, (b) => Uint8Array.of(b)))).toEqual(EXPECTED);
  });

  it('gives the same result for 300 random chunkings', () => {
    const bytes = enc.encode(TEXT);
    const next = prng(42);
    for (let run = 0; run < 300; run++) {
      expect(parseAll(randomSplit(bytes, next)), `run ${run}`).toEqual(EXPECTED);
    }
  });

  it.each([
    ['CRLF', '\r\n'],
    ['lone CR', '\r'],
  ])('handles %s line endings, even when a "\\r" and its "\\n" are in different chunks', (_name, eol) => {
    const bytes = enc.encode(TEXT.replaceAll('\n', eol));
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(parseAll([bytes.slice(0, cut), bytes.slice(cut)]), `cut at ${cut}`).toEqual(EXPECTED);
    }
    expect(parseAll(Array.from(bytes, (b) => Uint8Array.of(b)))).toEqual(EXPECTED);
  });

  it('does not emit a frame until its blank line arrives', () => {
    const parser = new SseParser();
    expect(parser.push(enc.encode('data: {"x":1}\n'))).toEqual([]);
    expect(parser.push(enc.encode('\n'))).toEqual([{ event: null, data: '{"x":1}' }]);
  });

  it('delivers a final frame that has no blank-line terminator at end()', () => {
    const parser = new SseParser();
    expect(parser.push(enc.encode('data: {"usage":1}'))).toEqual([]);
    expect(parser.end()).toEqual([{ event: null, data: '{"usage":1}' }]);
  });

  it('ignores comments, id and retry; `event` applies to one frame only', () => {
    const events = parseAll([
      enc.encode(': ping\nid: 7\nretry: 1000\nevent: a\ndata: 1\n\ndata: 2\n\n: only a comment\n\n'),
    ]);
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: null, data: '2' },
    ]);
  });

  it('strips exactly one leading space after the colon and allows a missing space', () => {
    expect(parseAll([enc.encode('data:nospace\n\ndata:  two\n\n')])).toEqual([
      { event: null, data: 'nospace' },
      { event: null, data: ' two' },
    ]);
  });

  it('an empty `data:` line is an event with empty data; a frame with no data lines is nothing', () => {
    expect(parseAll([enc.encode('data:\n\nevent: x\n\n')])).toEqual([{ event: null, data: '' }]);
  });

  it('never throws on invalid UTF-8', () => {
    expect(() => parseAll([Uint8Array.of(0xff, 0xfe, 0x0a, 0x0a)])).not.toThrow();
  });

  it('bounds memory: an oversized line is dropped, later events still parse', () => {
    const parser = new SseParser(50);
    const events = [
      ...parser.push(enc.encode('data: ' + 'x'.repeat(100))), // no newline yet, already over the cap
      ...parser.push(enc.encode('x'.repeat(100) + '\n\n')),
      ...parser.push(enc.encode('data: ok\n\n')),
      ...parser.end(),
    ];
    expect(events).toEqual([{ event: null, data: 'ok' }]);
    expect(parser.overflowed).toBe(true);
  });

  it('does not retain text once a frame has been delivered', () => {
    const parser = new SseParser();
    parser.push(enc.encode('data: SECRET-PROMPT-TEXT\n\n'));
    expect(JSON.stringify(parser)).not.toContain('SECRET-PROMPT-TEXT');
  });
});
