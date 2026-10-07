import { describe, expect, it } from "vitest";
import {
  ApiTimeoutError,
  apiErrorMessage,
  isTransientStatus,
  isTransportError,
  readApiJson,
} from "../src/apiResponse";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "Content-Type": "text/html" } });

describe("isTransientStatus", () => {
  it("treats timeouts, rate limits and server errors as retryable", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isTransientStatus(s)).toBe(true);
  });
  it("treats client errors as permanent", () => {
    for (const s of [400, 401, 403, 404, 409, 410, 422]) expect(isTransientStatus(s)).toBe(false);
  });
});

describe("isTransportError", () => {
  it("recognizes network failures and timeouts", () => {
    expect(isTransportError(new TypeError("Network request failed"))).toBe(true);
    expect(isTransportError(new ApiTimeoutError(30_000))).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isTransportError(abort)).toBe(true);
  });
  it("does not treat ordinary errors as transport failures", () => {
    expect(isTransportError(new Error("boom"))).toBe(false);
    expect(isTransportError("nope")).toBe(false);
  });
});

describe("apiErrorMessage", () => {
  it("reads every error shape the endpoints send", () => {
    expect(apiErrorMessage({ error: "not signed in" })).toBe("not signed in");
    expect(apiErrorMessage({ error: { message: "busy", retryable: true } })).toBe("busy");
    expect(
      apiErrorMessage({
        error: { formErrors: ["bad"], fieldErrors: { bounds: ["Search area too large."] } },
      }),
    ).toBe("bad, Search area too large.");
  });
  it("returns undefined when there is nothing to show", () => {
    expect(apiErrorMessage(undefined)).toBeUndefined();
    expect(apiErrorMessage({ error: "" })).toBeUndefined();
    expect(apiErrorMessage({ error: { formErrors: [], fieldErrors: {} } })).toBeUndefined();
  });
});

describe("readApiJson", () => {
  it("returns data for a JSON 2xx", async () => {
    await expect(readApiJson(json({ a: 1 }))).resolves.toEqual({
      ok: true,
      status: 200,
      data: { a: 1 },
    });
  });

  it("classifies a non-JSON 2xx (captive portal) as retryable", async () => {
    const r = await readApiJson(text("<html>login</html>", 200));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryable).toBe(true);
  });

  it("never surfaces an HTML error page as the message", async () => {
    const r = await readApiJson(text("<html>An error occurred</html>", 504), "fallback");
    expect(r).toMatchObject({ ok: false, status: 504, message: "fallback", retryable: true });
  });

  it("uses the status to decide retryability when the server doesn't say", async () => {
    await expect(readApiJson(json({ error: "gone" }, 410))).resolves.toMatchObject({
      ok: false,
      message: "gone",
      retryable: false,
    });
    await expect(readApiJson(json({ error: "upstream" }, 502))).resolves.toMatchObject({
      retryable: true,
    });
  });

  it("honors an explicit retryable flag over the status", async () => {
    await expect(
      readApiJson(json({ error: { message: "bad tag", retryable: false } }, 503)),
    ).resolves.toMatchObject({ retryable: false, message: "bad tag" });
  });
});
