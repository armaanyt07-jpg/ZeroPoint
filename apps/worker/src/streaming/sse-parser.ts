// The decoder is provider-agnostic and pure, so it lives in packages/providers (the
// adapters' one-shot `parseStreamChunk` needs it too). Re-exported here to match
// the SRS section 15 layout.
export { DEFAULT_MAX_BUFFER_CHARS, SseParser } from '@zeropoint/providers';
