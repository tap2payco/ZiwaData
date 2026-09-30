/** Deterministic PRNG for seed data. Same seed string, same numbers, on every machine. */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export class Rng {
  private next: () => number;
  constructor(seed: string) {
    this.next = mulberry32(hashSeed(seed));
  }
  float(): number {
    return this.next();
  }
  /** Roughly normal, mean 0, sd about 0.5 (sum of 3 uniforms), bounded to +/-1.5. */
  noise(): number {
    return (this.next() + this.next() + this.next() - 1.5) / 1.5 * 1;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
