# pi-codex-image-gen Guidelines

Root `AGENTS.md` applies.

## Invariants

- Keep `codex_generate_image` schema, skill guidance, config, and tests synchronized.
- Own image OAuth under `codex-images`; let Pi store and refresh credentials. Preserve legacy Pi `openai-codex` fallback only when owned credentials are absent. Never use the `openai` plan-sharing chat token, Codex app credentials, API-key billing, or log tokens/auth headers.
- Keep the OAuth implementation independent of Pi's legacy OAuth helpers. Validate PKCE/state, honor cancellation, bound token responses, and do not switch accounts after an auth failure.
- Treat `skills/imagegen/scripts/image_gen.py` as vendored; preserve attribution and avoid casual edits.
- Preserve save modes and config keys unless making an explicit breaking change.
- Fork `./host` is separate from the default CLI entry: keep its byte-only interface generic, strict `codex-images` OAuth, no telemetry, and zero automatic image-request retries. Application tools, host binding, and product states belong to consumers. Preserve the fixed 0.1.15 source provenance in `FORK.md`.

## Validation

```bash
npm run -w packages/pi-codex-image-gen check
npm test -w packages/pi-codex-image-gen
npm run -w packages/pi-codex-image-gen pack:dry-run
```

Smoke test extension loading and Python helpers after relevant changes; use `uv` for Python dependencies.
