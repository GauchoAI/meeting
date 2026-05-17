export interface MeetingPeer {
  id: string;
  name: string;
}

export type MeetingSignal =
  | { type: "hello"; roomId: string; from: MeetingPeer }
  | { type: "bye"; roomId: string; from: MeetingPeer }
  | { type: "offer"; roomId: string; from: MeetingPeer; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; from: MeetingPeer; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; roomId: string; from: MeetingPeer; to: string; candidate: RTCIceCandidateInit };

export interface MeetingSignalingAdapter {
  publish(signal: MeetingSignal): Promise<void>;
  subscribe(roomId: string, onSignal: (signal: MeetingSignal) => void): Promise<() => void>;
}

export interface MultiHumanRoomOptions {
  roomId: string;
  self: MeetingPeer;
  localStream: MediaStream;
  signaling: MeetingSignalingAdapter;
  rtcConfig?: RTCConfiguration;
  onRemoteStream?: (peer: MeetingPeer, stream: MediaStream) => void;
  onPeerLeft?: (peerId: string) => void;
  onDebug?: (message: string, details?: unknown) => void;
}

interface PeerState {
  peer: MeetingPeer;
  connection: RTCPeerConnection;
  remoteStream: MediaStream;
}

const defaultRtcConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

export class MultiHumanRoom {
  private readonly options: MultiHumanRoomOptions;
  private readonly peers = new Map<string, PeerState>();
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(options: MultiHumanRoomOptions) {
    this.options = options;
  }

  async join(): Promise<void> {
    if (this.unsubscribe) return;
    this.closed = false;
    this.unsubscribe = await this.options.signaling.subscribe(this.options.roomId, (signal) => {
      void this.handleSignal(signal).catch((error) => this.debug("signal handling failed", error));
    });
    await this.publish({ type: "hello", roomId: this.options.roomId, from: this.options.self });
  }

  async leave(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.publish({ type: "bye", roomId: this.options.roomId, from: this.options.self }).catch(() => undefined);
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const state of this.peers.values()) {
      state.connection.close();
    }
    this.peers.clear();
  }

  private async handleSignal(signal: MeetingSignal): Promise<void> {
    if (this.closed || signal.roomId !== this.options.roomId || signal.from.id === this.options.self.id) return;
    if ("to" in signal && signal.to !== this.options.self.id) return;

    if (signal.type === "hello") {
      await this.createOffer(signal.from);
      return;
    }
    if (signal.type === "bye") {
      this.removePeer(signal.from.id);
      return;
    }
    if (signal.type === "offer") {
      const state = this.getOrCreatePeer(signal.from);
      await state.connection.setRemoteDescription(signal.sdp);
      const answer = await state.connection.createAnswer();
      await state.connection.setLocalDescription(answer);
      await this.publish({ type: "answer", roomId: this.options.roomId, from: this.options.self, to: signal.from.id, sdp: answer });
      return;
    }
    if (signal.type === "answer") {
      const state = this.peers.get(signal.from.id);
      if (!state) return;
      await state.connection.setRemoteDescription(signal.sdp);
      return;
    }
    if (signal.type === "ice") {
      const state = this.peers.get(signal.from.id);
      if (!state) return;
      await state.connection.addIceCandidate(signal.candidate);
    }
  }

  private async createOffer(peer: MeetingPeer): Promise<void> {
    const state = this.getOrCreatePeer(peer);
    const offer = await state.connection.createOffer();
    await state.connection.setLocalDescription(offer);
    await this.publish({ type: "offer", roomId: this.options.roomId, from: this.options.self, to: peer.id, sdp: offer });
  }

  private getOrCreatePeer(peer: MeetingPeer): PeerState {
    const existing = this.peers.get(peer.id);
    if (existing) return existing;

    const connection = new RTCPeerConnection(this.options.rtcConfig || defaultRtcConfig);
    const remoteStream = new MediaStream();
    const state: PeerState = { peer, connection, remoteStream };
    this.peers.set(peer.id, state);

    for (const track of this.options.localStream.getTracks()) {
      connection.addTrack(track, this.options.localStream);
    }

    connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      void this.publish({
        type: "ice",
        roomId: this.options.roomId,
        from: this.options.self,
        to: peer.id,
        candidate: event.candidate.toJSON()
      });
    });

    connection.addEventListener("track", (event) => {
      for (const track of event.streams[0]?.getTracks() || [event.track]) {
        if (!remoteStream.getTrackById(track.id)) remoteStream.addTrack(track);
      }
      this.options.onRemoteStream?.(peer, remoteStream);
    });

    connection.addEventListener("connectionstatechange", () => {
      this.debug("peer connection state", { peerId: peer.id, state: connection.connectionState });
      if (["closed", "failed", "disconnected"].includes(connection.connectionState)) this.removePeer(peer.id);
    });

    return state;
  }

  private removePeer(peerId: string): void {
    const state = this.peers.get(peerId);
    if (!state) return;
    state.connection.close();
    this.peers.delete(peerId);
    this.options.onPeerLeft?.(peerId);
  }

  private publish(signal: MeetingSignal): Promise<void> {
    return this.options.signaling.publish(signal);
  }

  private debug(message: string, details?: unknown): void {
    this.options.onDebug?.(message, details);
  }
}

export function createMeetingPeerId(): string {
  return globalThis.crypto?.randomUUID?.() || `peer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
