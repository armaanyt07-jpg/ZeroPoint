import { createDependencies } from './deps';
import type { Env } from './env';
import { route } from './router';
import { ConsoleTelemetry } from './telemetry';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Dependencies are built per request and hold no mutable state, so any
    // Worker instance at any edge location can serve any request (NFR-5.4).
    // `ctx` lets background work (cache writes) finish after the response is sent.
    // Every request gets its own id, which tags all of its log lines and is
    // returned as the x-request-id response header. A client-supplied
    // x-request-id is ignored so ids can't be spoofed or used to inject log text.
    const requestId = crypto.randomUUID();
    const telemetry = new ConsoleTelemetry({ request_id: requestId });
    return route(request, () => createDependencies(env, ctx, telemetry), telemetry, requestId);
  },
} satisfies ExportedHandler<Env>;
