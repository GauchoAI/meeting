import type { MeetingEvent, PartialUtteranceEvent, UtteranceEvent } from "@meeting/protocol";

export interface TranscriptLine {
  speakerId: string;
  speakerLabel: string;
  text: string;
  startMs: number;
  endMs?: number;
  final: boolean;
}

export class TranscriptBuffer {
  private lines: TranscriptLine[] = [];
  private partialBySpeaker = new Map<string, TranscriptLine>();

  apply(event: MeetingEvent): TranscriptLine[] {
    if (event.type === "utterance.partial") {
      this.applyPartial(event);
    }
    if (event.type === "utterance.final") {
      this.applyFinal(event);
    }
    return this.snapshot();
  }

  applyAll(events: MeetingEvent[]): TranscriptLine[] {
    this.lines = [];
    this.partialBySpeaker.clear();
    for (const event of events) {
      this.apply(event);
    }
    return this.snapshot();
  }

  snapshot(): TranscriptLine[] {
    return [...this.lines, ...this.partialBySpeaker.values()].sort((a, b) => a.startMs - b.startMs);
  }

  private applyPartial(event: PartialUtteranceEvent): void {
    this.partialBySpeaker.set(event.speakerId, {
      speakerId: event.speakerId,
      speakerLabel: event.speakerLabel,
      text: event.text,
      startMs: event.startMs,
      final: false
    });
  }

  private applyFinal(event: UtteranceEvent): void {
    this.partialBySpeaker.delete(event.speakerId);
    this.lines.push({
      speakerId: event.speakerId,
      speakerLabel: event.speakerLabel,
      text: event.text,
      startMs: event.startMs,
      endMs: event.endMs,
      final: true
    });
  }
}
