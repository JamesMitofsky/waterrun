import type { CorePorts } from "./ports";

// The single place each app wires its platform adapters into @water-run/core. Call
// configureCore(ports) once at startup (before any store action runs); the stores
// read the registry lazily via corePorts(), which throws loudly if it was skipped.
const holder: { ports: CorePorts | null } = { ports: null };

export const configureCore = (ports: CorePorts): void => {
  holder.ports = ports;
};

export const corePorts = (): CorePorts => {
  if (!holder.ports) {
    throw new Error(
      "@water-run/core is not configured — call configureCore(ports) at app startup before using the stores.",
    );
  }
  return holder.ports;
};
