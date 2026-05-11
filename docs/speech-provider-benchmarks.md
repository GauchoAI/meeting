# Speech Provider Benchmarks

This page records the local speech provider benchmark shape, latest measured runs, and the current provider recommendations for the Meeting app.

## Benchmark Command

Run all local providers that are installed or configured:

```bash
pnpm benchmark:speech
```

Useful focused runs:

```bash
pnpm benchmark:speech -- --tts=mlx-voxtral --stt=none --timeout-ms=60000
pnpm benchmark:speech -- --tts=qwen3-tts --stt=none --timeout-ms=180000
pnpm benchmark:speech -- --tts=none --stt=parakeet-http --timeout-ms=30000
```

Outputs are written under `.meeting/tmp/speech-provider-benchmarks/<run-id>/`, which is ignored by git. Each run writes `speech-provider-benchmark.json`, `speech-provider-benchmark.md`, generated STT fixtures, and any generated TTS audio.

The benchmark uses the same English, Spanish, and Russian TTS texts for every TTS provider. STT fixtures cover short dictation, longer continuous-conversation chunks, a stop/interruption phrase, and multilingual technical terms.

## Latest Local Runs

Measured on May 11, 2026 from this repo on the local Mac.

| Run | Command | Result file | Key result |
| --- | --- | --- | --- |
| Provider availability probe | `pnpm benchmark:speech -- --timeout-ms=5000` | `.meeting/tmp/speech-provider-benchmarks/2026-05-11T03-59-09-602Z/speech-provider-benchmark.json` | No speech servers were already listening; unavailable providers were recorded without failing the benchmark. |
| Parakeet STT | `pnpm benchmark:speech -- --timeout-ms=30000 --tts=none --stt=parakeet-http` | `.meeting/tmp/speech-provider-benchmarks/2026-05-11T03-59-54-668Z/speech-provider-benchmark.json` | 7/7 STT cases passed; average elapsed time 237.696 ms; average word recall 0.709. |
| MLX Voxtral TTS | `pnpm benchmark:speech -- --timeout-ms=60000 --stream-idle-ms=2500 --tts=mlx-voxtral --stt=none` | `.meeting/tmp/speech-provider-benchmarks/2026-05-11T04-02-54-012Z/speech-provider-benchmark.json` | 6/6 TTS cases passed; average first audio 3174.512 ms across full-file and stream modes; average RTF 0.539. Streaming first audio was 418-500 ms. |
| Qwen3 TTS | `pnpm benchmark:speech -- --timeout-ms=180000 --tts=qwen3-tts --stt=none` | `.meeting/tmp/speech-provider-benchmarks/2026-05-11T04-04-43-507Z/speech-provider-benchmark.json` | 3/3 TTS cases passed; average first audio 17642.718 ms; average RTF 2.807. Too slow for live speech. |

## TTS Results

| Provider | Mode | Language | First audio ms | Total ms | Audio duration sec | RTF | Bytes | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| MLX Voxtral | full-file | English | 2226.939 | 2227.375 | 4.08 | 0.546 | 195884 | Fast enough after complete-utterance batching. |
| MLX Voxtral | stream | English | 418.237 | 4338.947 | 7.84 | 0.553 | 376320 | Best live first-audio behavior. |
| MLX Voxtral | full-file | Spanish | 3602.534 | 3602.925 | 6.88 | 0.524 | 330284 | Use Spanish voice auto-selection. |
| MLX Voxtral | stream | Spanish | 500.015 | 5013.916 | 8.96 | 0.56 | 430080 | Best live Spanish option measured here. |
| MLX Voxtral | full-file | Russian | 11853.638 | 11854.631 | 24.08 | 0.492 | 1155884 | Output was much longer than the input warrants; keep Russian experimental. |
| MLX Voxtral | stream | Russian | 445.706 | 40289.039 | 72 | 0.56 | 3456000 | Low first-audio latency but runaway duration; not a Russian default. |
| Qwen3 TTS | full-file | English | 24165.534 | 24166.693 | 6.16 | 3.923 | 295724 | Good offline candidate only. |
| Qwen3 TTS | full-file | Spanish | 13897.191 | 13897.583 | 6.08 | 2.286 | 291884 | Too slow for live Spanish speech. |
| Qwen3 TTS | full-file | Russian | 14865.428 | 14866.286 | 6.72 | 2.212 | 322604 | Offline Russian candidate. |
| Chatterbox Turbo | full-file | English/Spanish/Russian | n/a | n/a | n/a | n/a | n/a | Unavailable in the local availability probe; start `scripts/start-chatterbox-tts.sh` and rerun before choosing it. |

## STT Results

| Provider | Scenario | Language | Elapsed ms | Word recall | Notes |
| --- | --- | --- | ---: | ---: | --- |
| Parakeet | short dictation | English | 225.548 | 0.7 | Correct intent; normalized "standup" and "3 PM" differently. |
| Parakeet | continuous conversation 01 | English | 329.361 | 1 | No continuous-chunk failure observed. |
| Parakeet | continuous conversation 02 | English | 269.846 | 1 | No drop across the second long chunk. |
| Parakeet | barge-in stop phrase | English | 144.541 | 1 | Recognized stop/interruption intent clearly. |
| Parakeet | multilingual technical terms | English | 268.121 | 0.667 | Misheard several provider names; post-processing glossary may help. |
| Parakeet | Spanish technical terms | Spanish | 213.289 | 0.429 | Weak on English product names inside Spanish speech. |
| Parakeet | Russian technical terms | Russian | 213.165 | 0.167 | Not reliable for Russian technical terminology. |
| Local Whisper / Voxtral STT / Moshi STT | all | all | n/a | n/a | Unavailable in the local availability probe; rerun after starting those bridges. |

## Recommendation Matrix

| Use case | STT default | TTS default | Status | Reason |
| --- | --- | --- | --- | --- |
| Live meeting speech | Parakeet HTTP | MLX Voxtral streaming | Recommended local default | Parakeet passed continuous and stop-phrase cases; MLX streams first audio in about 0.4-0.5 seconds and stays faster than real time for English/Spanish. |
| Narration/offline artifacts | Parakeet HTTP | Qwen3 TTS | Recommended offline default | Qwen3 supports English, Spanish, and Russian, but RTF 2.212-3.923 means it should run when latency can be hidden. |
| English | Parakeet HTTP | MLX Voxtral live, Qwen3 offline | Recommended | Parakeet continuous English recall was 1.0; MLX was live-capable. |
| Spanish | Parakeet HTTP | MLX Voxtral live with `VOXTRAL_MLX_TTS_SPANISH_VOICE` | Recommended with term caveat | MLX live Spanish measured well. Parakeet should remain default, but technical names in Spanish need glossary/post-processing or human review. |
| Russian | Parakeet HTTP only for rough capture | Qwen3 offline | Experimental | Qwen3 is slow but bounded. MLX Russian generated overly long audio, and Parakeet Russian technical-term recall was poor. |
| Experimental full-duplex | Moshi HTTP | Qwen3 or MLX by test | Experimental | Keep Moshi out of stable defaults until it provides reliable transcript and interruption events. |

## Current Defaults

Committed local defaults in `config/meeting.local.json` now express the split directly:

```json
{
  "speechMode": "live",
  "sttProvider": "parakeet-http",
  "liveTtsProvider": "mlx-voxtral",
  "narrationTtsProvider": "qwen3-tts"
}
```

Use `.env` to override without editing committed config:

```env
MEETING_SPEECH_MODE=live
MEETING_LIVE_STT_PROVIDER=parakeet-http
MEETING_LIVE_TTS_PROVIDER=mlx-voxtral
MEETING_NARRATION_TTS_PROVIDER=qwen3-tts
```

Direct overrides still work:

```env
STT_PROVIDER=local-whisper
MEETING_TTS_PROVIDER=chatterbox-turbo
```

## Practical Notes

- Keep Parakeet as the STT default. The benchmark did not show a continuous-conversation failure, and the measured latency is appropriate for local live meetings.
- Do not use Qwen3 as the live TTS default. It remained slower than real time in all measured languages.
- Use MLX Voxtral as the live TTS default for English and Spanish, but keep Russian experimental until output duration and quality are controlled.
- Generated audio and logs stay under `.meeting/tmp`; do not commit benchmark artifacts.
