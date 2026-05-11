# Goal Plan: Local Speech Benchmark And Provider Selector

Use this with Codex CLI:

```text
/goal Build a unified local speech benchmark and provider selector for the Meeting app. Use the full objective and acceptance criteria from this archived plan.
```

## Objective

Build a unified local speech benchmark and provider selector for the Meeting app in `/Users/miguel_lemos/Desktop/mamba3/meeting`.

## Budget

Work autonomously for up to 4 hours, or until the acceptance criteria pass.

Commit stable milestones.

Stop and ask before deleting source code, secrets, active model assets, or anything that looks like unrecovered work.

## Context

The current stack uses Parakeet STT plus local TTS providers including Qwen3 TTS, MLX Voxtral TTS, and the previous local TTS provider.

Qwen3 supports English, Spanish, and Russian, but it is too slow for live Spanish speech. Keep it available for narration/offline artifact audio if useful.

Parakeet STT is currently strong, but we need to validate continuous-conversation behavior, not only push-to-talk dictation.

## Acceptance Criteria

1. Add a unified benchmark script for installed speech providers.
2. Benchmark TTS providers with the same English, Spanish, and Russian texts.
3. For each TTS provider, measure first-audio latency if available, total synthesis time, output audio duration, real-time factor, bytes generated, failure rate, provider/model metadata, and language used.
4. Benchmark STT with short dictation, longer continuous-conversation chunks, interruption/barge-in behavior, and multilingual technical terms.
5. Record benchmark outputs under `.meeting/tmp` or another ignored runtime folder.
6. Document results in `docs/speech-provider-benchmarks.md` with a clear recommendation matrix for live meeting speech, narration/offline artifacts, English, Spanish, Russian, and experimental status.
7. Keep Parakeet as the STT default unless the benchmark shows a concrete continuous-conversation failure.
8. Choose the best live TTS default separately from narration/offline TTS.
9. Do not force Qwen3 as live default if it remains slower than real time.
10. Update `.env.example` and relevant docs so switching STT/TTS providers is straightforward.
11. If useful, add a small provider selector/config helper so the app can express modes like `live`, `narration`, and `experimental`.
12. Run relevant typechecks/tests after changes.
13. Commit each stable milestone with concise commit messages.
14. Leave the app in a runnable state with the current recommended local defaults.

## Implementation Guidance

- Prefer objective measurements over subjective impressions.
- Do not over-optimize a model that is fundamentally too slow for live use.
- Preserve the existing Meeting app architecture: stable shell, Pi/Codex integration, realtime transcript, artifacts, and local speech services.
- Keep generated benchmark audio and logs out of git.
- Keep secrets out of logs and docs.
- Prefer small scripts and clear docs over fragile one-off commands.
- If a model/server is not installed or not running, mark it as unavailable instead of failing the whole benchmark.
- If a provider supports streaming, measure streaming separately from full-file synthesis.
- If a provider is non-streaming, estimate whether prefetch can hide latency by comparing synthesis time to audio duration.
- Include practical notes about Spanish and Russian quality where measurable or observed.
