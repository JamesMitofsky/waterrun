import { describe, expect, it, vi } from "vitest";
import { submitToFormspree } from "@/lib/formspree";

const ENDPOINT = "https://formspree.io/f/test";
const GENERIC = "Something went wrong. Please try again.";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const stubFetch = (reply: Response | Error) => {
  const fetchMock =
    reply instanceof Error ? vi.fn().mockRejectedValue(reply) : vi.fn().mockResolvedValue(reply);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("submitToFormspree", () => {
  it("posts the payload as JSON and asks for a JSON reply", async () => {
    const fetchMock = stubFetch(json({ ok: true }, 200));

    expect(await submitToFormspree(ENDPOINT, { email: "a@b.co" })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ email: "a@b.co" });
  });

  it("surfaces the first message of Formspree's error body", async () => {
    stubFetch(json({ errors: [{ message: "Email is invalid" }, { message: "Other" }] }, 422));

    expect(await submitToFormspree(ENDPOINT, {})).toEqual({
      ok: false,
      message: "Email is invalid",
    });
  });

  it("falls back to the generic message for a non-JSON error body", async () => {
    stubFetch(new Response("<html>Bad Gateway</html>", { status: 502 }));

    expect(await submitToFormspree(ENDPOINT, {})).toEqual({ ok: false, message: GENERIC });
  });

  it.each([
    ["no errors field", { error: "nope" }],
    ["errors not an array", { errors: "nope" }],
    ["an empty errors list", { errors: [] }],
    ["a non-string message", { errors: [{ message: 42 }] }],
    ["an entry without a message", { errors: [{ code: "TYPE_EMAIL" }] }],
    ["an empty message", { errors: [{ message: "" }] }],
    ["a JSON null body", null],
  ])("falls back to the generic message for %s", async (_, body) => {
    stubFetch(json(body, 400));

    expect(await submitToFormspree(ENDPOINT, {})).toEqual({ ok: false, message: GENERIC });
  });

  it("reports a network failure as such", async () => {
    stubFetch(new TypeError("Failed to fetch"));

    expect(await submitToFormspree(ENDPOINT, {})).toEqual({
      ok: false,
      message: "Network error. Please try again.",
    });
  });

  it("does not call out when the form has no endpoint", async () => {
    const fetchMock = stubFetch(json({}, 200));

    expect(await submitToFormspree(undefined, {}, "Not set up")).toEqual({
      ok: false,
      message: "Not set up",
    });
    expect(await submitToFormspree("", {})).toEqual({
      ok: false,
      message: "This form isn't configured yet. Please try again later.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
