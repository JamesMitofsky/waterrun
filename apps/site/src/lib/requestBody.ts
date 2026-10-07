// The request's JSON body, or undefined when it isn't JSON. Routes validate the
// result with zod, so a malformed body becomes an ordinary 400 instead of an
// exception that escapes as the framework's HTML 500, which clients can't parse.
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
