import { beforeEach, describe, expect, it } from "vitest";
import { callApi, postJson, TOO_SLOW, UNREACHABLE } from "../src/apiCall";
import { ApiTimeoutError } from "../src/apiResponse";
import { configureTestPorts } from "./helpers/ports";

let apiFetch: ReturnType<typeof configureTestPorts>["apiFetch"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  ({ apiFetch } = configureTestPorts());
});

describe("callApi", () => {
  it("passes the deadline to the port and returns the JSON reply", async () => {
    apiFetch.mockResolvedValueOnce(json({ nodeId: 5 }));
    const reply = await callApi("/api/x", postJson({ a: 1 }), 1234, "fallback");
    expect(reply).toEqual({ ok: true, status: 200, data: { nodeId: 5 } });
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ method: "POST", body: '{"a":1}' }),
      { timeoutMs: 1234 },
    );
  });

  it("turns no reply at all into a retryable failure with a plain message", async () => {
    apiFetch.mockRejectedValueOnce(new TypeError("Network request failed"));
    const reply = await callApi("/api/x", {}, 1000, "fallback");
    expect(reply).toEqual({
      ok: false,
      status: 0,
      message: UNREACHABLE,
      retryable: true,
      body: undefined,
    });
  });

  it("says the server was too slow when the deadline passed", async () => {
    apiFetch.mockRejectedValueOnce(new ApiTimeoutError(1000));
    const reply = await callApi("/api/x", {}, 1000, "fallback");
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toBe(TOO_SLOW);
  });

  it("reads an error body's message, including a zod tree", async () => {
    apiFetch.mockResolvedValueOnce(
      json({ error: { formErrors: [], fieldErrors: { lat: ["Too big"] } } }, 400),
    );
    const reply = await callApi("/api/x", {}, 1000, "fallback");
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.message).toBe("Too big");
      expect(reply.retryable).toBe(false);
    }
  });

  it("rethrows a failure that isn't the network's", async () => {
    apiFetch.mockRejectedValueOnce(new RangeError("bug"));
    await expect(callApi("/api/x", {}, 1000, "fallback")).rejects.toThrow("bug");
  });
});
