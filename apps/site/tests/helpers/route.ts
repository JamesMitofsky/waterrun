import type { APIContext } from "astro";

// Just enough of Astro's endpoint context for the routes under test.
export function routeContext(request: Request, extra: Partial<APIContext> = {}): APIContext {
  return { request, ...extra } as unknown as APIContext;
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// A stand-in for Astro's cookie jar: serves the request's cookies and records
// what the route set and deleted.
export function fakeCookies(incoming: Record<string, string> = {}) {
  const set = new Map<string, { value: string; options?: Record<string, unknown> }>();
  const deleted = new Set<string>();
  const cookies = {
    get: (key: string) => (key in incoming ? { value: incoming[key] } : undefined),
    set: (key: string, value: string, options?: Record<string, unknown>) => {
      set.set(key, { value, options });
      deleted.delete(key);
    },
    delete: (key: string) => {
      deleted.add(key);
      set.delete(key);
    },
  } as unknown as APIContext["cookies"];
  return { cookies, set, deleted };
}
