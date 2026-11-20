// The site's footer links, as data rather than markup, so a test can check that
// every internal one lands on a page that exists (tests/lib/siteLinks.test.ts).
// The policy links matter beyond the site: App Store Connect requires a
// Privacy Policy URL and a Support URL, and both point at pages listed here.

export const REPO_URL = "https://github.com/JamesMitofsky/waterrun";

export type SiteLink = {
  label: string;
  href: string;
  /** Opens in a new tab. Decides target/rel, not styling. */
  external?: boolean;
};

export type LinkColumn = {
  heading: string;
  links: SiteLink[];
};

export const FOOTER_COLUMNS: LinkColumn[] = [
  {
    heading: "Explore",
    links: [
      { label: "Home", href: "/" },
      { label: "Fountain map", href: "/public-drinking-fountains" },
      { label: "Join the waitlist", href: "/waitlist" },
    ],
  },
  {
    heading: "Project",
    links: [
      { label: "Contribute on GitHub", href: REPO_URL, external: true },
      { label: "Share feedback", href: "/feedback" },
    ],
  },
];

export const POLICY_LINKS: SiteLink[] = [
  { label: "Privacy Policy", href: "/privacy-policy" },
  { label: "Terms of Service", href: "/terms-of-service" },
  { label: "Support", href: "/help" },
];
