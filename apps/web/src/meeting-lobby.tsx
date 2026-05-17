import { useEffect, useMemo, useState } from "react";
import { advertisePublicMeeting, firebaseMeetingConfigStatus, subscribePublicMeetings, type PublicMeetingRecord } from "./firebase-meetings.js";

interface MeetingLobbyProps {
  api: string;
  query: URLSearchParams;
}

function useHostIdentity() {
  return useMemo(() => {
    const existing = localStorage.getItem("meeting.hostId");
    if (existing) return existing;
    const next = globalThis.crypto?.randomUUID?.() || `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("meeting.hostId", next);
    return next;
  }, []);
}

function meetingDetails(api: string, query: URLSearchParams) {
  return {
    isAdvertising: query.get("advertise") === "1" || query.get("host") === "1",
    meetingId: query.get("meeting") || localStorage.getItem("meeting.id") || "local-demo",
    title: query.get("title") || localStorage.getItem("meeting.title") || "Miguel's Meeting",
    hostName: query.get("hostName") || localStorage.getItem("meeting.hostName") || "Host",
    api
  };
}

export function MeetingAdvertiser({ api, query }: MeetingLobbyProps) {
  const [error, setError] = useState("");
  const hostId = useHostIdentity();
  const { isAdvertising, meetingId, title, hostName } = meetingDetails(api, query);

  useEffect(() => {
    if (!isAdvertising) return;
    localStorage.setItem("meeting.id", meetingId);
    localStorage.setItem("meeting.title", title);
    localStorage.setItem("meeting.hostName", hostName);
    return advertisePublicMeeting({
      meetingId,
      title,
      hostId,
      hostName,
      apiUrl: api,
      signalingRoomId: meetingId,
      visibility: "public",
      participantCount: 1
    }, (nextError) => setError(nextError.message));
  }, [api, hostId, hostName, isAdvertising, meetingId, title]);

  if (!isAdvertising || !error) return null;
  return <div className="lobbyNotice error">Meeting advertisement failed: {error}</div>;
}

export function MeetingLobby({ api, query }: MeetingLobbyProps) {
  const [meetings, setMeetings] = useState<PublicMeetingRecord[]>([]);
  const [error, setError] = useState("");
  const status = firebaseMeetingConfigStatus();
  const hostId = useHostIdentity();
  const { isAdvertising, meetingId, title, hostName } = meetingDetails(api, query);

  useEffect(() => {
    setError("");
    return subscribePublicMeetings(setMeetings, (nextError) => setError(nextError.message));
  }, []);

  useEffect(() => {
    if (!isAdvertising) return;
    localStorage.setItem("meeting.id", meetingId);
    localStorage.setItem("meeting.title", title);
    localStorage.setItem("meeting.hostName", hostName);
    return advertisePublicMeeting({
      meetingId,
      title,
      hostId,
      hostName,
      apiUrl: api,
      signalingRoomId: meetingId,
      visibility: "public",
      participantCount: 1
    }, (nextError) => setError(nextError.message));
  }, [api, hostId, hostName, isAdvertising, meetingId, title]);

  function joinMeeting(meeting: PublicMeetingRecord) {
    const params = new URLSearchParams({ meeting: meeting.id, peerOnly: "1", name: localStorage.getItem("meeting.peerName") || "Guest" });
    // HTTPS Pages cannot call a plain HTTP host API because of browser mixed-content rules.
    // In guest mode, the browser should join over WebRTC/Firebase and let the host browser
    // forward audio to its local API/model stack.
    if (!(window.location.protocol === "https:" && meeting.apiUrl.startsWith("http://"))) {
      params.set("api", meeting.apiUrl);
    }
    window.location.href = `./stable.html?${params.toString()}`;
  }

  function advertiseUrl() {
    const params = new URLSearchParams({ advertise: "1", api, meeting: meetingId, title, hostName });
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  }

  return (
    <section className="meetingLobby" aria-label="Public meeting lobby">
      <div className="meetingLobbyHeader">
        <div>
          <p className="eyebrow">GitHub Pages lobby</p>
          <h1>Online Meetings</h1>
          <p>Find a host, join their live Meeting, and speak into the same shared AI context.</p>
        </div>
        <div className={isAdvertising ? "lobbyBadge live" : "lobbyBadge"}>{isAdvertising ? "Advertising this host" : "Guest discovery"}</div>
      </div>

      {!status.configured && (
        <div className="lobbyNotice">
          Firebase is not configured in this build, so the public meeting list is offline. Configure the `VITE_FIREBASE_*` variables for GitHub Pages.
        </div>
      )}
      {error && <div className="lobbyNotice error">{error}</div>}

      {isAdvertising && (
        <div className="hostCard">
          <strong>{title}</strong>
          <span>Host: {hostName}</span>
          <span>API: {api}</span>
          <span>Meeting id: {meetingId}</span>
          <small>Guests will see this room while the page remains open. Closing it removes the advertisement or lets it expire.</small>
        </div>
      )}

      <div className="lobbyGrid">
        {meetings.length > 0 ? meetings.map((meeting) => (
          <article className="meetingCard" key={meeting.id}>
            <div>
              <h2>{meeting.title || meeting.id}</h2>
              <p>Hosted by {meeting.host?.name || "Host"}</p>
              <small>{meeting.participantCount || 1} participant · {Math.max(0, Math.round((Date.now() - Number(meeting.updatedAtMs || 0)) / 1000))}s ago</small>
            </div>
            <button onClick={() => joinMeeting(meeting)}>Join</button>
          </article>
        )) : (
          <div className="emptyLobby">No public meetings are online right now.</div>
        )}
      </div>

      <details className="hostHelp">
        <summary>Host this meeting publicly</summary>
        <p>Open the lobby with an HTTPS API tunnel and advertising enabled:</p>
        <code>{advertiseUrl()}</code>
      </details>
    </section>
  );
}
