import fengari from 'fengari';

/**
 * Runs a real Lua script (fengari = the Lua VM in JavaScript) against an
 * in-memory key/value map, with just enough of Redis's `redis.call` to execute
 * ZeroPoint's settlement script: SET (with NX/EX) and INCRBYFLOAT. The point is
 * that the SCRIPT TEXT that ships is what the tests execute, not a JS re-implementation.
 * NOT a Redis emulator: any other command throws.
 */
const { lua, lauxlib, lualib, to_luastring } = fengari as {
  lua: Record<string, (...args: never[]) => unknown> & Record<string, unknown>;
  lauxlib: Record<string, (...args: never[]) => unknown>;
  lualib: Record<string, (...args: never[]) => unknown>;
  to_luastring: (s: string) => unknown;
};
type L = never;
const call = <T>(fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => T)(...args);

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

  call(lua['lua_createtable'], state, 0, 1);
  call(lua['lua_pushjsfunction'], state, (s: L) => {
    const argc = call<number>(lua['lua_gettop'], s);
    const argv: string[] = [];
    for (let i = 1; i <= argc; i++) argv.push(call<string>(lua['lua_tojsstring'], s, i));
    const [command, key, value, ...options] = argv;
    if (command === 'SET') {
      const nx = options.includes('NX');
      if (nx && data.has(key!)) {
        call(lua['lua_pushboolean'], s, 0); // Redis returns nil -> false in Lua
      } else {
        data.set(key!, value!);
        call(lua['lua_pushboolean'], s, 1);
      }
      return 1;
    }
    if (command === 'INCRBYFLOAT') {
      const next = Number(data.get(key!) ?? '0') + Number(value);
      data.set(key!, String(next));
      call(lua['lua_pushstring'], s, to_luastring(String(next)));
      return 1;
    }
    throw new Error(`Unsupported command in test Lua runner: ${String(command)}`);
  });
  call(lua['lua_setfield'], state, -2, to_luastring('call'));
  call(lua['lua_setglobal'], state, to_luastring('redis'));

  const loadStatus = call<number>(lauxlib['luaL_loadstring'], state, to_luastring(script));
  if (loadStatus !== 0) throw new Error(`Lua load error: ${call<string>(lua['lua_tojsstring'], state, -1)}`);
  const status = call<number>(lua['lua_pcall'], state, 0, 1, 0);
  if (status !== 0) throw new Error(`Lua error: ${call<string>(lua['lua_tojsstring'], state, -1)}`);
  return call<number>(lua['lua_tointeger'], state, -1);
}
