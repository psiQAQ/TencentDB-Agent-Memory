# Gateway contract artifacts

`types.ts` and `schemas.ts` contain the paired TypeScript and Zod gateway contract.
`npm run typecheck` checks their consistency with the production callers.

Kubb is configured in `MemoryCore/kubb.config.ts`. Its input,
`MemoryCore/docs/team-api-仅memory.yaml`, is not included in this checkout.
Restore the matching OpenAPI contract before running Kubb; its output directory
is cleaned during generation. Review both generated files together and run the
Core type check and gateway tests after regeneration.

Wiki and CodeGraph routes use the maintained knowledge schemas and handlers in
`src/gateway/`; their operations are not part of this generated type contract.
