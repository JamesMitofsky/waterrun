import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleTimeout, type VisibilitySource } from "@/lib/visibleTimeout";

// A document whose visibility the test flips, firing `visibilitychange` the
// way a browser does when the tab is hidden or shown.
class FakeDocument extends EventTarget implements VisibilitySource {
  visibilityState: DocumentVisibilityState;
  constructor(state: DocumentVisibilityState) {
    super();
    this.visibilityState = state;
  }
  show() {
    this.visibilityState = "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
  hide() {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("visibleTimeout", () => {
  it("fires after `ms` on a page that stays visible, and not before", () => {
    const cb = vi.fn();
    visibleTimeout(20_000, cb, new FakeDocument("visible"));
    vi.advanceTimersByTime(19_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("does not count time while the page is hidden", () => {
    const doc = new FakeDocument("hidden");
    const cb = vi.fn();
    visibleTimeout(20_000, cb, doc);
    // A background tab left for a minute: the map has had no frames to load in.
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    doc.show();
    vi.advanceTimersByTime(19_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("keeps the time already spent visible across a hide", () => {
    const doc = new FakeDocument("visible");
    const cb = vi.fn();
    visibleTimeout(20_000, cb, doc);
    vi.advanceTimersByTime(15_000);
    doc.hide();
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    doc.show();
    vi.advanceTimersByTime(4_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("ignores a repeated visible event rather than restarting the clock", () => {
    const doc = new FakeDocument("visible");
    const cb = vi.fn();
    visibleTimeout(20_000, cb, doc);
    vi.advanceTimersByTime(10_000);
    doc.show();
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("never fires once cancelled, and stops listening", () => {
    const doc = new FakeDocument("visible");
    const remove = vi.spyOn(doc, "removeEventListener");
    const cb = vi.fn();
    const cancel = visibleTimeout(20_000, cb, doc);
    vi.advanceTimersByTime(10_000);
    cancel();
    doc.hide();
    doc.show();
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("fires only once, however the page is shown and hidden after", () => {
    const doc = new FakeDocument("visible");
    const cb = vi.fn();
    visibleTimeout(1_000, cb, doc);
    vi.advanceTimersByTime(1_000);
    doc.hide();
    doc.show();
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledOnce();
  });
});
