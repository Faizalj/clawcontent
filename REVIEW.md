# Code Review Guidelines

## Always check
- New steps in `steps/` export valid PipelineStep with requires/provides
- No hardcoded API keys, tokens, or secrets
- No modifications to pipeline.ts, server.ts, db.ts, index.html (discuss first)
- Step uses helpers from `steps/helpers.ts` not duplicate code
- Output files go in `ctx.outputDir`
- Error messages are clear and actionable

## Step contract
- `requires` lists all context fields the step needs
- `provides` lists all context fields the step sets
- Step handles missing optional dependencies gracefully (skip, not crash)

## Skip
- Formatting-only changes
- Comment-only changes
- Changes to MEMORY/ or output/
