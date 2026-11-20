import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FOOTER_COLUMNS, POLICY_LINKS } from "@/lib/siteLinks";

const PAGES_DIR = path.resolve(__dirname, "../../src/pages");

// The page file Astro serves an internal path from: `/` is index.astro, and
// `/foo` is either foo.astro or foo/index.astro.
function pageExists(href: string): boolean {
  const route = href.replace(/[?#].*$/, "").replace(/\/$/, "");
  const candidates =
    route === ""
      ? ["index.astro"]
      : [`${route.slice(1)}.astro`, path.join(route.slice(1), "index.astro")];
  return candidates.some((file) => existsSync(path.join(PAGES_DIR, file)));
}

const footerLinks = [...FOOTER_COLUMNS.flatMap((c) => c.links), ...POLICY_LINKS];

describe("footer links", () => {
  it.each(footerLinks.filter((l) => !l.external).map((l) => [l.label, l.href]))(
    "%s (%s) lands on a page that exists",
    (_label, href) => {
      expect(href.startsWith("/")).toBe(true);
      expect(pageExists(href)).toBe(true);
    },
  );

  it("opens only absolute URLs in a new tab", () => {
    for (const link of footerLinks.filter((l) => l.external)) {
      expect(link.href).toMatch(/^https:\/\//);
    }
  });

  // App Store Connect requires a Privacy Policy URL and a Support URL, and
  // review checks they are reachable from the site.
  it("links the pages App Store Connect points at", () => {
    const hrefs = POLICY_LINKS.map((l) => l.href);
    expect(hrefs).toEqual(
      expect.arrayContaining(["/privacy-policy", "/terms-of-service", "/help"]),
    );
  });
});
