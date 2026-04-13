// KCode — Agent codename generator
//
// Assigns memorable, distinctive names to spawned agents so users can
// refer to them naturally ("vamos a esperar a Atlas que termine").
// Names are drawn from a curated list of 60+ astronomical and
// mythological names. When the pool exhausts the list, the generator
// falls back to numeric suffixes (Atlas-2, Atlas-3).
//
// Names are released back to the pool when an agent finishes, so a
// long session never runs out as long as completed agents are
// cleaned up.

/**
 * Curated codename pool, organized by category for variety. The order
 * is intentional: the first names are the most recognizable (Atlas,
 * Orion, Vega), so early agents get memorable names. Later picks are
 * still evocative but less famous.
 */
const CODENAMES: readonly string[] = [
  // ── Greek titans and gods (most recognizable) ──────────────────
  "Atlas", "Athena", "Apollo", "Hermes", "Artemis", "Hephaestus",
  // ── Bright constellations and stars ────────────────────────────
  "Orion", "Vega", "Lyra", "Sirius", "Polaris", "Cassiopeia",
  "Andromeda", "Perseus", "Pegasus", "Draco", "Cygnus", "Hydra",
  "Antares", "Rigel", "Betelgeuse", "Procyon", "Arcturus", "Capella",
  "Deneb", "Altair", "Spica", "Regulus",
  // ── Astronomical objects and phenomena ─────────────────────────
  "Nova", "Pulsar", "Quasar", "Nebula", "Helix", "Cosmos",
  // ── Greek elemental / minor gods ───────────────────────────────
  "Aether", "Eos", "Nyx", "Helios", "Selene", "Hypnos", "Zephyr",
  // ── Other mythological / abstract ──────────────────────────────
  "Aurora", "Vesper", "Solstice", "Mira", "Echo", "Iris",
  // ── More constellations ────────────────────────────────────────
  "Corvus", "Aquila", "Centaurus", "Auriga", "Cepheus", "Phoenix",
  "Columba", "Lupus", "Ursa", "Scorpius",
];

/**
 * Allocates and releases codenames for agents. Keeps track of which
 * names are in use so no two live agents ever share a name. When
 * the pool runs out of unique codenames, appends a numeric suffix
 * to the next available one (Atlas-2, Atlas-3, …).
 */
export class NameGenerator {
  private inUse: Set<string> = new Set();
  /** Counters for numeric suffixes when the base pool is exhausted. */
  private overflowCounters: Map<string, number> = new Map();

  /**
   * Reserve the next free name. Never returns the same name twice
   * for concurrent agents. Prefers the curated pool in order, then
   * falls back to suffixed overflow.
   */
  reserve(): string {
    for (const name of CODENAMES) {
      if (!this.inUse.has(name)) {
        this.inUse.add(name);
        return name;
      }
    }
    // All base names are taken — generate a suffixed overflow name.
    const base = CODENAMES[this.inUse.size % CODENAMES.length]!;
    const count = (this.overflowCounters.get(base) ?? 1) + 1;
    this.overflowCounters.set(base, count);
    const name = `${base}-${count}`;
    this.inUse.add(name);
    return name;
  }

  /**
   * Return a name to the pool so it can be reused by a future agent.
   * Called by the pool when an agent finishes or is cancelled.
   */
  release(name: string): void {
    this.inUse.delete(name);
  }

  /** Check if a name is currently assigned to a live agent. */
  isTaken(name: string): boolean {
    return this.inUse.has(name);
  }

  /** How many names are currently in use. */
  activeCount(): number {
    return this.inUse.size;
  }

  /** Clear all reservations. Used on pool reset / session start. */
  reset(): void {
    this.inUse.clear();
    this.overflowCounters.clear();
  }

  /** List all currently reserved names. For debug / snapshot. */
  listActive(): string[] {
    return Array.from(this.inUse);
  }
}

/** Total codenames available in the curated pool (for docs / UI). */
export const CODENAME_POOL_SIZE = CODENAMES.length;
