declare module "../pkg/more_space.js" {
  export default function init(): Promise<void>;
  export function generate_universe(seed: bigint): string;
  export function init_game(seed: bigint): void;
  export function revision(): bigint;
  export function snapshot(): string;
  export function submit_team_intent(
    command_id: bigint,
    expected_revision: bigint,
    team_id: number,
    intent_json: string,
  ): string;
  export function hex_grid(radius: number): string;
  export function hex_window(center_q: number, center_r: number, radius: number): string;
}
