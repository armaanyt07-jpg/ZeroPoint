import { createDependencies } from './deps';
import type { Env } from './env';
import { ZeroPointError, toErrorResponse } from './errors';
import { route } from './router';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Dependencies are built per request and hold no mutable state, so any
      // Worker instance at any edge location can serve any request (NFR-5.4).
      return await route(request, () => createDependencies(env));
    } catch (error) {
      if (error instanceof ZeroPointError) return toErrorResponse(error);
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
