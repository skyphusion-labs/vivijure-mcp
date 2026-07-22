# AGENTS.md

## Cursor Cloud specific instructions

Standard scripts are in `package.json`. Non-obvious VM gotchas:

- **Run the JS toolchain under Node 24.** The VM's default `node` is a wrapper
  (`/exec-daemon/node`, v22.14) that shadows nvm. Keep the workspace on Node 24
  (installed via nvm by the environment update script) so bare-`node` `.ts`
  type-stripping works: `export PATH="$HOME/.nvm/versions/node/v24"*"/bin:$PATH"`.
- **Install deps with the default Node 22 `npm` (v10), not Node 24's `npm` (v11).**
  npm 11 blocks the `esbuild` postinstall (a native binary vitest needs) behind an
  interactive allow-scripts prompt. Run `npm ci` on the default PATH, then run
  typecheck/test/build under Node 24.

Verified in this environment (Node 24): `npm ci`, `npm run typecheck`,
`npm test` (17 passed), `npm run build` all pass.
