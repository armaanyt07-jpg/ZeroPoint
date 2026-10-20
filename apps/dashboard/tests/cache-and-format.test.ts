import { apiKeyCacheKey } from "@zeropoint/schemas";
import { describe, expect, it, vi } from "vitest";
import { deleteCacheKeys } from "@/lib/cache";
import { formatDateTime, formatDuration, formatUsd, formatUsdTick } from "@/lib/format";
import { escapeLike, sinceDaysAgo } from "@/lib/queries";

const ENV = { url: "https://redis.example", token: "t0ken" };

describe("deleteCacheKeys (docs/PHASE_4_PLAN.md D8)", () => {
  it("sends one DEL with every key to the Upstash REST endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: 2 })));
    expect(await deleteCacheKeys([apiKeyCacheKey("a"), apiKeyCacheKey("b")], ENV, fetchImpl as unknown as typeof fetch)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENV.url);
    expect(JSON.parse(String(init.body))).toEqual(["DEL", "cache:apikey:a", "cache:apikey:b"]);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t0ken");
  });

  it("is a no-op success for no keys, and false (never a throw) when unconfigured or failing", async () => {
    const fetchImpl = vi.fn();
    expect(await deleteCacheKeys([], ENV, fetchImpl as unknown as typeof fetch)).toBe(true);
    expect(await deleteCacheKeys(["k"], null, fetchImpl as unknown as typeof fetch)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    const down = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await deleteCacheKeys(["k"], ENV, down as unknown as typeof fetch)).toBe(false);
    const http500 = vi.fn(async () => new Response("", { status: 500 }));
    expect(await deleteCacheKeys(["k"], ENV, http500 as unknown as typeof fetch)).toBe(false);
    const redisError = vi.fn(async () => new Response(JSON.stringify({ error: "WRONGPASS" })));
    expect(await deleteCacheKeys(["k"], ENV, redisError as unknown as typeof fetch)).toBe(false);
  });
});

describe("formatting", () => {
  it("keeps tiny costs visible instead of rounding them to $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1284.4)).toBe("$1,284.40");
    expect(formatUsd(0.0523)).toBe("$0.0523");
    expect(formatUsd(0.00003)).toBe("$0.000030");
  });

  it("dates are UTC and null means never", () => {
    expect(formatDateTime("2026-10-10T12:34:56Z")).toBe("2026-10-10 12:34 UTC");
    expect(formatDateTime(null)).toBe("Never");
  });

  it("durations read naturally", () => {
    expect(formatDuration(900)).toBe("15 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(45)).toBe("45 s");
  });
});

describe("query helpers", () => {
  it("escapes LIKE wildcards so a search matches literally", () => {
    expect(escapeLike("user_1%")).toBe("user\\_1\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("a range of N days starts at UTC midnight N-1 days ago (N chart columns including today)", () => {
    const now = Date.UTC(2026, 9, 10, 15, 30);
    expect(sinceDaysAgo(1, now)).toBe("2026-10-10T00:00:00.000Z");
    expect(sinceDaysAgo(7, now)).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("formatUsdTick", () => {
  it("keeps sub-dollar ticks distinct instead of printing $0 everywhere", () => {
    expect([0, 0.025, 0.05, 0.075, 0.1].map(formatUsdTick)).toEqual(["$0", "$0.025", "$0.05", "$0.075", "$0.1"]);
    expect(formatUsdTick(0.00012345)).toBe("$0.00012");
    expect(formatUsdTick(250)).toBe("$250");
    expect(formatUsdTick(12500)).toBe("$12.5K");
  });
});
