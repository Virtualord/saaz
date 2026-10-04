## What this changes

## Why

## Verification

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] `npm run prove:offline` still verifies (required if you touched the pipeline)

## Models touched

If you changed anything in `server/models/registry.ts`, say which and why.

Model choices in this project were made from measurements, not reputation — see
`npm run bench:asr` and `npm run bench:caption`. Please attach the numbers, because two of the
four defaults were chosen precisely because a *larger* model failed the task.