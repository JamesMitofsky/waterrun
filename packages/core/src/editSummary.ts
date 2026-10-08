import type { EditAction, EditExtras } from "./schemas";

// The calendar day of `d` on this device, as YYYY-MM-DD.
export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The device's calendar date: the day the surveyor is out there, which
// toISOString() would not give (it is UTC, already tomorrow on a US evening
// run). The outbox sends it with each edit as surveyDate, so the check_date OSM
// receives matches this optimistic summary.
export function todayLocal(): string {
  return localIsoDate(new Date());
}

// Human-readable summary of an edit. Shared by the server edit route (real write)
// and the client outbox (optimistic, shown before the write reaches OSM).
export function editSummary(
  action: EditAction | "broken",
  tagKey: string,
  today: string,
  extras?: EditExtras,
): string {
  let base: string;
  switch (action) {
    case "confirm":
      base = `confirmed · check_date=${today}`;
      break;
    case "broken":
      base = `marked working but broken · check_date=${today}`;
      break;
    case "out_of_order":
      base = `${tagKey} → disused:${tagKey} · check_date=${today}`;
      break;
    case "removed":
      base = `${tagKey} → abandoned:${tagKey} · check_date=${today}`;
      break;
  }
  // Mirror applyAction's gating so the optimistic summary matches the OSM write.
  if (extras?.seasonal && action === "confirm") {
    base += " · seasonal=yes";
  }
  if (extras?.audience && action === "confirm") {
    // drinking_water=yes is redundant on a drinking_water primary, so only the
    // informative =no (dogs-only) is surfaced; dog=* always is.
    if (extras.audience === "dogs") base += " · drinking_water=no";
    base += ` · dog=${extras.audience === "humans" ? "no" : "yes"}`;
  }
  if (extras?.dispenser && action === "confirm") {
    // bottle=* is redundant on fountain=bottle_refill, so surface it only on a
    // bubbler (=yes for "both", =no for bubbler-only).
    if (extras.dispenser === "bottle") {
      base += " · fountain=bottle_refill";
    } else {
      base += ` · fountain=bubbler · bottle=${extras.dispenser === "both" ? "yes" : "no"}`;
    }
  }
  if (extras?.note) base += " · note added";
  return base;
}
