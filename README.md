# more-space

Rust + WebAssembly + Vite simulation project.

## Prerequisites
- Rust (`rustup`; pinned via `rust-toolchain.toml`)
- `wasm-pack`
- Node.js (`.nvmrc`)
- npm

## Setup
```bash
nvm use
npm install
cargo install wasm-pack
```

Optional check:
```bash
rustup show active-toolchain
```

## Daily dev
Full local loop (test + typecheck + wasm build + dev server):
```bash
npm run dev:full
```

Fast loop (skip tests/typecheck):
```bash
npm run wasm && npm run dev
```

## Useful commands
```bash
npm run verify      # cargo test -q + typecheck
npm run wasm        # rebuild pkg/
npm run dev         # vite dev server
npm run typecheck   # ts check
cargo test -q       # rust tests + ts-rs binding sync
npm run build:local # wasm + frontend build
```

## Generated outputs
- `pkg/`: wasm artifacts from `wasm-pack`
- `www/bindings/`: TypeScript types from Rust (`ts-rs`)

Do not manually edit `www/bindings/*`.

## Troubleshooting
If TS commands fail with old Node syntax:
```bash
nvm use
npm run typecheck
```

If `nvm` complains about `npm_config_prefix`:
```bash
unset npm_config_prefix
nvm use
npx tsc --noEmit
```

If frontend behavior/types look stale:
```bash
npm run verify
npm run wasm
```
Then restart `npm run dev`.
