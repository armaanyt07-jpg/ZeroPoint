import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/PHASE_4_PLAN.md Risks: the dashboard server holds the service-role key,
 * the encryption key and the Redis token, so ONE Server Action that forgets the
 * admin check exposes everything. This test fails if any exported Server Action
 * is not built with `adminAction(...)`, except the sign-in/sign-out file, which
 * must work without a session.
 */
const APP = join(import.meta.dirname, "../app");
const ALLOWED_UNWRAPPED = new Set(["login/actions.ts"]);

function serverActionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return serverActionFiles(path);
    return /\.(ts|tsx)$/.test(name) && /^\s*["']use server["']/.test(readFileSync(path, "utf8")) ? [path] : [];
  });
}

describe("every Server Action requires an admin", () => {
  const files = serverActionFiles(APP);

  it("finds the action files", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of files) {
    const name = relative(APP, file);
    if (ALLOWED_UNWRAPPED.has(name)) continue;
    it(name, () => {
      const source = readFileSync(file, "utf8");
      const exports = source.split("\n").filter((line) => /^export\s/.test(line));
      expect(exports.length).toBeGreaterThan(0);
      for (const line of exports) {
        expect(line, `${name}: "${line.trim()}" must be \`export const x = adminAction(...)\``).toMatch(/^export const \w+ = adminAction\(/);
      }
    });
  }
});
