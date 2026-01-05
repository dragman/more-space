declare module "../pkg/more_space.js" {
  export default function init(): Promise<void>;
  export function generate_universe(seed: bigint): string;
  export function hex_grid(radius: number): string;
}
