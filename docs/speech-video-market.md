# Speech, Video, and Agent Meeting Options

This document compares choices for the first `meeting` product: a human meeting
room where local Codex/Claude workers listen to transcripts, raise hands, speak
when invited, and work on repositories during the call.

## Video Transport

| Option | Cost profile | Strengths | Weaknesses | Fit |
| --- | ---: | --- | --- | --- |
| P2P WebRTC mesh | Lowest infra cost when direct peer connections work | No SFU participant-minute bill, simple for 2-3 people, good privacy story | Upload bandwidth grows with every participant, TURN relay can still cost money, harder server-side recording/STT, weaker for larger rooms | Good MVP if we keep meetings small |
| LiveKit Cloud SFU | Usage-based participant minutes + data transfer | Reliable scaling, room APIs, permissions, server-side media, agent-friendly | More paid infra than P2P | Best product foundation |
| Agora / Daily / 100ms SFU | Usage-based participant minutes | Managed meeting infrastructure, faster than self-hosting | Provider lock-in, less agent-native than LiveKit | Good alternatives |

P2P can reduce cost, especially for very small meetings. The tradeoff is that
each participant may need to upload separate streams to every other participant.
For a 2-person call this is excellent. For 4-6 people it can become unreliable,
especially on asymmetric home internet.

For transcription, P2P also means we need a deliberate capture point:

- each client can stream its own microphone audio to STT;
- the host can capture a mixed audio stream;
- or an agent client can join and receive audio.

Per-speaker client-side STT gives better attribution and interruption behavior,
but the STT cost scales with speaker-minutes.

## Interruption Requirements

For agents that can be interrupted and react quickly, provider choice matters
more than raw transcript price.

The minimum viable voice loop is:

1. low-latency streaming STT with partial transcripts;
2. voice activity detection / turn detection;
3. agent hand-raise protocol;
4. streaming TTS playback;
5. barge-in: stop TTS immediately when a human starts speaking or the host
   mutes the agent.

Batch transcription is not enough for this. We need streaming STT or short
chunks with aggressive VAD. Deepgram Flux, Azure Speech realtime, ElevenLabs
Scribe realtime, and similar streaming providers are better fits than
file-oriented transcription for the final product.

## Ranked By Cost

Approximate public pay-as-you-go prices. Verify again before production because
speech pricing changes frequently.

| Rank | STT | TTS | Approx cost | Notes |
| ---: | --- | --- | ---: | --- |
| 1 | AssemblyAI STT | Deepgram Aura-1 | STT from about $0.15/hr; TTS $0.015/1k chars | Cheap STT; separate TTS vendor |
| 2 | ElevenLabs Scribe batch | Deepgram Aura-1 | STT $0.22/hr; TTS $0.015/1k chars | Low cost, good language coverage |
| 3 | OpenAI gpt-4o-mini-transcribe | OpenAI TTS / gpt-4o-mini-tts | STT about $0.003/min; TTS token/character priced | Simple integration; good baseline |
| 4 | Deepgram Nova-3 / Flux | Deepgram Aura-1 or Aura-2 | STT $0.0077/min; TTS $0.015-$0.030/1k chars | Better realtime agent fit |
| 5 | ElevenLabs Scribe realtime | ElevenLabs Flash/Turbo | STT $0.39/hr; TTS $0.05/1k chars | Polished voice stack |
| 6 | Azure AI Speech | Azure Neural TTS | Region/model dependent | Enterprise stack; pricing depends on selected tier/region |

Cost ranking is not the same as product ranking. A slightly more expensive
streaming provider may save engineering time if it has better partials, endpoint
events, diarization, and barge-in behavior.

## Ranked By Quality / Product Fit

| Rank | Provider | Why |
| ---: | --- | --- |
| 1 | Deepgram STT + ElevenLabs TTS | Strong realtime STT plus best-sounding agent voices |
| 2 | Deepgram STT + Deepgram Aura TTS | One vendor, low-latency voice-agent path, simpler barge-in |
| 3 | Azure Speech STT + Azure Neural TTS | Enterprise-safe, solid realtime SDKs, strong compliance story |
| 4 | OpenAI / Azure OpenAI transcription + OpenAI TTS | Simple and accurate; good if already in OpenAI/Azure |
| 5 | AssemblyAI STT + Deepgram/ElevenLabs TTS | Cost-effective STT, but less ideal as the realtime voice loop |
| 6 | Google/AWS speech stacks | Mature cloud options, good if already committed to GCP/AWS |

## Best Combinations

| Use case | Video | STT | TTS | Why |
| --- | --- | --- | --- | --- |
| Cheapest small MVP | P2P WebRTC | OpenAI mini transcribe or AssemblyAI | Deepgram Aura-1 | Minimal media infra, low speech cost |
| Best realtime agent behavior | LiveKit Cloud or P2P | Deepgram Flux/Nova-3 streaming | Deepgram Aura-2 | Low latency, turn/interruption oriented |
| Best agent voice quality | LiveKit Cloud or P2P | Deepgram or Azure Speech | ElevenLabs Flash/Turbo | Agents sound better when granted floor |
| Enterprise Azure path | LiveKit Cloud or P2P | Azure AI Speech | Azure Neural TTS | Single enterprise cloud/security story |
| Public-repo coding meetings | P2P first, LiveKit later | Deepgram or OpenAI | OpenAI/Deepgram | Keep hosting low; use GitHub Actions/Pages for previews |

## Recommendation

Start with two interchangeable adapters:

- `VideoTransportProvider`: `p2p-webrtc` first, `livekit-cloud` second.
- `SpeechProvider`: start with `openai` or `azure`, but keep `deepgram` as a
  first-class target because interruption and latency are central to the product.

Updated project decision: the MVP should support P2P for 2-3 people and local
Whisper STT first. Deepgram remains the fallback for cases where local latency
or quality are not good enough. Agents do not need TTS in the first product
shape; they express themselves through Markdown, Mermaid diagrams, visible task
cards, branches, diffs, and previews.

## Sources

- LiveKit pricing: https://livekit.com/pricing
- LiveKit billing: https://docs.livekit.io/home/cloud/billing
- Deepgram pricing: https://deepgram.com/pricing
- AssemblyAI pricing: https://www.assemblyai.com/pricing/
- ElevenLabs API pricing: https://elevenlabs.io/pricing/api/
- OpenAI audio model pricing: https://openai.com/api/pricing/
- Azure AI Speech pricing: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
