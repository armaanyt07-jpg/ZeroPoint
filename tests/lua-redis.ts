import fengari from 'fengari';

/**
 * Runs a real Lua script (fengari = the Lua VM in JavaScript) against an
 * in-memory key/value map, with just enough of Redis's `redis.call` to execute
 * ZeroPoint's settlement and circuit-breaker scripts: SET (NX/EX), INCRBYFLOAT,
 * EXISTS, EXPIRE, and the sorted-set/list commands used for velocity tracking
 * and pattern hashing. The point is that the SCRIPT TEXT that ships is what the
 * tests execute, not a JS re-implementation. NOT a Redis emulator: any other
 * command throws.
 *
 * Sorted sets and lists are stored as JSON in the same string map: a sorted
 * set is `[[member, score], ...]`, a list is `[element, ...]`. These shapes
 * never collide with plain GET/SET values because the two never share a key
 * namespace (spend:/settled: vs. velocity:/hashes:).
 */
const { lua, lauxlib, lualib, to_luastring } = fengari as {
  lua: Record<string, (...args: never[]) => unknown> & Record<string, unknown>;
  lauxlib: Record<string, (...args: never[]) => unknown>;
  lualib: Record<string, (...args: never[]) => unknown>;
  to_luastring: (s: string) => unknown;
};
type L = never;
const call = <T>(fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => T)(...args);

type ZMember = [string, number];

function readZset(data: Map<string, string>, key: string): ZMember[] {
  const raw = data.get(key);
  return raw ? (JSON.parse(raw) as ZMember[]) : [];
}
function writeZset(data: Map<string, string>, key: string, members: ZMember[]): void {
  if (members.length === 0) data.delete(key);
  else data.set(key, JSON.stringify(members));
}
function readList(data: Map<string, string>, key: string): string[] {
  const raw = data.get(key);
  return raw ? (JSON.parse(raw) as string[]) : [];
}
function writeList(data: Map<string, string>, key: string, elements: string[]): void {
  if (elements.length === 0) data.delete(key);
  else data.set(key, JSON.stringify(elements));
}

/**
 * Redis's ZRANGE/LRANGE/LTRIM index rule: both ends are inclusive, negative counts
 * from the end (-1 = last element), and either end is clamped into the array.
 * Always resolves against the FULL length (an off-by-one here previously made
 * "0 -1" — "everything" — drop the last element).
 */
function resolveInclusiveIndex(index: number, length: number): number {
  const resolved = index < 0 ? length + index : index;
  return Math.max(0, Math.min(resolved, Math.max(length - 1, 0)));
}

export function runLuaScript(
  script: string,
  keys: string[],
  args: (string | number)[],
  data: Map<string, string>,
): unknown {
  const state = lauxlib['luaL_newstate']!() as L;
  call(lualib['luaL_openlibs'], state);

  const pushStringTable = (name: string, values: (string | number)[]) => {
    call(lua['lua_createtable'], state, values.length, 0);
    values.forEach((value, index) => {
      call(lua['lua_pushstring'], state, to_luastring(String(value)));
      call(lua['lua_rawseti'], state, -2, index + 1);
    });
    call(lua['lua_setglobal'], state, to_luastring(name));
  };
  pushStringTable('KEYS', keys);
  pushStringTable('ARGV', args);

  const pushStringArray = (s: L, values: string[]) => {
    call(lua['lua_createtable'], s, values.length, 0);
    values.forEach((value, index) => {
      call(lua['lua_pushstring'], s, to_luastring(value));
      call(lua['lua_rawseti'], s, -2, index + 1);
    });
  };

  call(lua['lua_createtable'], state, 0, 1);
  call(lua['lua_pushjsfunction'], state, (s: L) => {
    const argc = call<number>(lua['lua_gettop'], s);
    const argv: string[] = [];
    for (let i = 1; i <= argc; i++) argv.push(call<string>(lua['lua_tojsstring'], s, i));
    const [command, key, ...rest] = argv;

    switch (command) {
      case 'SET': {
        const [value, ...options] = rest;
        const nx = options.includes('NX');
        if (nx && data.has(key!)) {
          call(lua['lua_pushboolean'], s, 0); // Redis returns nil -> false in Lua
        } else {
          data.set(key!, value!);
          call(lua['lua_pushboolean'], s, 1);
        }
        return 1;
      }
      case 'INCRBYFLOAT': {
        const next = Number(data.get(key!) ?? '0') + Number(rest[0]);
        data.set(key!, String(next));
        call(lua['lua_pushstring'], s, to_luastring(String(next)));
        return 1;
      }
      case 'EXISTS': {
        call(lua['lua_pushinteger'], s, data.has(key!) ? 1 : 0);
        return 1;
      }
      case 'EXPIRE': {
        call(lua['lua_pushinteger'], s, data.has(key!) ? 1 : 0);
        return 1;
      }
      case 'ZADD': {
        const [score, member] = rest;
        const members = readZset(data, key!).filter(([m]) => m !== member);
        members.push([member!, Number(score)]);
        writeZset(data, key!, members);
        call(lua['lua_pushinteger'], s, 1);
        return 1;
      }
      case 'ZREMRANGEBYSCORE': {
        const [minRaw, maxRaw] = rest;
        const min = minRaw === '-inf' ? -Infinity : Number(minRaw);
        const max = maxRaw === '+inf' ? Infinity : Number(maxRaw);
        const members = readZset(data, key!);
        const kept = members.filter(([, score]) => score < min || score > max);
        writeZset(data, key!, kept);
        call(lua['lua_pushinteger'], s, members.length - kept.length);
        return 1;
      }
      case 'ZRANGE': {
        const [startRaw, stopRaw] = rest;
        const members = readZset(data, key!).sort((a, b) => a[1] - b[1]);
        const start = resolveInclusiveIndex(Number(startRaw), members.length);
        const stop = resolveInclusiveIndex(Number(stopRaw), members.length);
        pushStringArray(s, members.slice(start, stop + 1).map(([m]) => m));
        return 1;
      }
      case 'LPUSH': {
        const list = readList(data, key!);
        list.unshift(...rest.slice().reverse());
        writeList(data, key!, list);
        call(lua['lua_pushinteger'], s, list.length);
        return 1;
      }
      case 'LTRIM': {
        const [startRaw, stopRaw] = rest;
        const list = readList(data, key!);
        const start = resolveInclusiveIndex(Number(startRaw), list.length);
        const stop = resolveInclusiveIndex(Number(stopRaw), list.length);
        writeList(data, key!, list.slice(start, stop + 1));
        call(lua['lua_pushboolean'], s, 1);
        return 1;
      }
      case 'LRANGE': {
        const [startRaw, stopRaw] = rest;
        const list = readList(data, key!);
        const start = resolveInclusiveIndex(Number(startRaw), list.length);
        const stop = resolveInclusiveIndex(Number(stopRaw), list.length);
        pushStringArray(s, list.slice(start, stop + 1));
        return 1;
      }
      default:
        throw new Error(`Unsupported command in test Lua runner: ${String(command)}`);
    }
  });
  call(lua['lua_setfield'], state, -2, to_luastring('call'));
  call(lua['lua_setglobal'], state, to_luastring('redis'));

  const loadStatus = call<number>(lauxlib['luaL_loadstring'], state, to_luastring(script));
  if (loadStatus !== 0) throw new Error(`Lua load error: ${call<string>(lua['lua_tojsstring'], state, -1)}`);
  const status = call<number>(lua['lua_pcall'], state, 0, 1, 0);
  if (status !== 0) throw new Error(`Lua error: ${call<string>(lua['lua_tojsstring'], state, -1)}`);
  return call<number>(lua['lua_tointeger'], state, -1);
}
