import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Navigation,
  Mic,
  Activity,
  BatteryCharging,
  Power,
  PowerOff,
  ArrowLeft,
  Sliders,
  ShieldCheck,
  Radio,
} from 'lucide-react';

export interface TelemetryPayload {
  type: 'SIGMA_TELEMETRY' | 'GPS_UPDATE';
  nodeId: string;
  senderId?: string;
  peerId: string;
  lat: number | null;
  lng: number | null;
  alt: number | null;
  accuracy: number | null;
  speed: number | null;
  battery: number | null;
  charging: boolean | null;
  timestamp: number;
  audioRms: number;
  remoteGain: number;
  remoteMuted: boolean;
  connectionStatus: 'connected';
}

interface SignalingMessage {
  type: string;
  id?: string;
  senderId?: string;
  targetId?: string;
  target?: string;
  sessionId?: string;
  packetId?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  data?: unknown;
  value?: number | boolean;
}

interface ClientProps {
  onExit: () => void;
  initialNodeId?: string;
  initialMasterPeerId?: string;
}

const LOGO_TNI_AU = '/assets/aistudio/images__10__b9efa126.jpeg';
const LOGO_PETIR = '/assets/aistudio/1794622160588-picsay_109de27f.png';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

function getSignalingWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function makePacketId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

export const Client: React.FC<ClientProps> = ({
  onExit,
  initialNodeId,
}) => {
  const [clientId] = useState<string>(() => {
    if (initialNodeId && initialNodeId.trim()) {
      return initialNodeId.trim();
    }
    try {
      const saved = sessionStorage.getItem('sigma_active_client_id');
      if (saved) return saved;
      const generated = String(Math.floor(1000 + Math.random() * 9000));
      sessionStorage.setItem('sigma_active_client_id', generated);
      return generated;
    } catch {
      return String(Math.floor(1000 + Math.random() * 9000));
    }
  });

  const [status, setStatus] = useState<string>('MENGHUBUNGKAN KE MASTER...');
  const [peerStatus, setPeerStatus] = useState<
    'INITIALIZING' | 'CONNECTED' | 'DISCONNECTED'
  >('INITIALIZING');
  const [micStatus, setMicStatus] = useState<'READY' | 'DENIED' | 'PENDING'>('PENDING');
  const [sensitivityGain, setSensitivityGain] = useState<number>(3.0); // Default 300% (3.0x)
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [audioRms, setAudioRms] = useState<number>(0);

  const [batteryInfo, setBatteryInfo] = useState<{
    level: number | null;
    charging: boolean | null;
  }>({
    level: null,
    charging: null,
  });

  const [gpsCoords, setGpsCoords] = useState<{
    lat: number | null;
    lng: number | null;
    alt: number | null;
    accuracy: number | null;
    speed: number | null;
    lastUpdated: number | null;
  }>({
    lat: null,
    lng: null,
    alt: null,
    accuracy: null,
    speed: null,
    lastUpdated: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const currentSessionIdRef = useRef<string>('');
  const seenPacketIdsRef = useRef<Set<string>>(new Set());
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const isRemoteDescReadyRef = useRef<boolean>(false);
  const isHandshakingRef = useRef<boolean>(false);
  const isBootstrappingRef = useRef<boolean>(false);
  const isManualDisconnectedRef = useRef<boolean>(false);
  const lastOfferSentAtRef = useRef<number>(0);
  const micInFlightRef = useRef<Promise<MediaStream | null> | null>(null);
  const connectWsFnRef = useRef<(() => void) | null>(null);

  const rawStreamRef = useRef<MediaStream | null>(null);
  const amplifiedStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const peerStatusRef = useRef(peerStatus);
  const gpsRef = useRef(gpsCoords);
  const batteryRef = useRef(batteryInfo);
  const rmsRef = useRef(audioRms);
  const gainValueRef = useRef(sensitivityGain);
  const mutedRef = useRef(isMuted);

  peerStatusRef.current = peerStatus;
  gpsRef.current = gpsCoords;
  batteryRef.current = batteryInfo;
  rmsRef.current = audioRms;
  gainValueRef.current = sensitivityGain;
  mutedRef.current = isMuted;

  // Update GainNode secara real-time saat slider sensitivitas diubah
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = isMuted ? 0 : sensitivityGain;
    }
    if (rawStreamRef.current) {
      rawStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = !isMuted;
      });
    }
    if (amplifiedStreamRef.current) {
      amplifiedStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = !isMuted;
      });
    }
  }, [sensitivityGain, isMuted]);

  // Wake Lock non-blocking
  const requestWakeLock = useCallback(() => {
    if ('wakeLock' in navigator && navigator.wakeLock) {
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          wakeLockRef.current = sentinel;
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    requestWakeLock();
    const onVisChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
      }
    };
  }, [requestWakeLock]);

  // Informasi Baterai
  useEffect(() => {
    const nav = navigator as unknown as {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        addEventListener: (type: string, cb: () => void) => void;
      }>;
    };
    if (nav.getBattery) {
      nav
        .getBattery()
        .then((bat) => {
          const updateBat = () => {
            setBatteryInfo({
              level: Math.round(bat.level * 100),
              charging: bat.charging,
            });
          };
          updateBat();
          bat.addEventListener('levelchange', updateBat);
          bat.addEventListener('chargingchange', updateBat);
        })
        .catch(() => {});
    }
  }, []);

  // Fungsi pengiriman sinyal jalur ganda (WebSocket + HTTP /api/signal dengan packetId anti-duplikat)
  const sendSignalingPacket = useCallback(
    async (packet: Record<string, unknown>) => {
      if (isManualDisconnectedRef.current) return;
      const payload = {
        ...packet,
        packetId:
          typeof packet.packetId === 'string'
            ? packet.packetId
            : makePacketId('c-sig'),
      };

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify(payload));
        } catch {}
      }

      try {
        const res = await fetch('/api/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok && !isManualDisconnectedRef.current) {
          setPeerStatus('CONNECTED');
          setStatus('TERHUBUNG KE MASTER');
        }
      } catch {}
    },
    []
  );

  // Fungsi kirim Telemetri GPS & Status ke Master via DataChannel ('tactical-telemetry'), WebSocket, & HTTP
  // PENTING: Tidak bergantung pada state `peerStatus` agar referensi fungsi selalu stabil!
  const transmitTelemetryPacket = useCallback(
    (overrideCoords?: {
      lat: number | null;
      lng: number | null;
      alt: number | null;
      accuracy: number | null;
      speed: number | null;
    }) => {
      if (isManualDisconnectedRef.current) return;
      const coords = overrideCoords || gpsRef.current;

      const gpsUpdatePacket = {
        type: 'GPS_UPDATE',
        nodeId: clientId,
        senderId: clientId,
        targetId: 'MASTER',
        lat: coords.lat,
        lng: coords.lng,
        alt: coords.alt,
        accuracy: coords.accuracy,
        speed: coords.speed,
        battery: batteryRef.current.level,
        charging: batteryRef.current.charging,
        audioRms: rmsRef.current,
        remoteGain: gainValueRef.current,
        remoteMuted: mutedRef.current,
        timestamp: Date.now(),
      };

      const sigmaTelemetryPacket: TelemetryPayload = {
        type: 'SIGMA_TELEMETRY',
        nodeId: clientId,
        senderId: clientId,
        peerId: `sigma-node-${clientId}`,
        lat: coords.lat,
        lng: coords.lng,
        alt: coords.alt,
        accuracy: coords.accuracy,
        speed: coords.speed,
        battery: batteryRef.current.level,
        charging: batteryRef.current.charging,
        timestamp: Date.now(),
        audioRms: rmsRef.current,
        remoteGain: gainValueRef.current,
        remoteMuted: mutedRef.current,
        connectionStatus: 'connected',
      };

      // 1. Kirim via RTCDataChannel ('tactical-telemetry') bila terbuka
      if (dcRef.current && dcRef.current.readyState === 'open') {
        try {
          dcRef.current.send(JSON.stringify(gpsUpdatePacket));
          dcRef.current.send(JSON.stringify(sigmaTelemetryPacket));
        } catch {}
      }

      // 2. Kirim via WebSocket & HTTP /api/signal agar Master selalu menerima posisi & status klien
      void sendSignalingPacket({
        ...sigmaTelemetryPacket,
        senderId: clientId,
        targetId: 'MASTER',
        packetId: makePacketId('c-tel'),
      });
    },
    [clientId, sendSignalingPacket]
  );

  // Akuisisi Mikrofon & Penguatan GainNode 300% (3.0x) TANPA memblokir WebSocket/WebRTC
  const ensureMicrophoneStream = useCallback(async (): Promise<MediaStream | null> => {
    if (amplifiedStreamRef.current && amplifiedStreamRef.current.active) {
      return amplifiedStreamRef.current;
    }
    if (rawStreamRef.current && rawStreamRef.current.active) {
      return rawStreamRef.current;
    }
    if (micInFlightRef.current) {
      return micInFlightRef.current;
    }

    const acquireTask = (async (): Promise<MediaStream | null> => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setMicStatus('DENIED');
        return null;
      }

      let rawStream: MediaStream | null = null;
      try {
        rawStream = await Promise.race([
          navigator.mediaDevices
            .getUserMedia({
              audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
              video: false,
            })
            .catch(() =>
              navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            ),
          new Promise<MediaStream | null>((resolve) =>
            setTimeout(() => resolve(null), 2500)
          ),
        ]);
      } catch {
        setMicStatus('DENIED');
        return null;
      }

      if (!rawStream) {
        return null;
      }

      rawStream.getAudioTracks().forEach((track) => {
        track.enabled = !mutedRef.current;
      });
      rawStreamRef.current = rawStream;
      setMicStatus('READY');

      // Setup AudioContext + GainNode (3.0x / 300%) tanpa await resume()
      try {
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new AudioContextClass();
        audioCtxRef.current = audioCtx;

        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }

        const source = audioCtx.createMediaStreamSource(rawStream);
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = mutedRef.current ? 0 : gainValueRef.current; // Default 3.0 (300%)
        gainNodeRef.current = gainNode;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;

        const destination = audioCtx.createMediaStreamDestination();

        source.connect(gainNode);
        gainNode.connect(analyser);
        gainNode.connect(destination);

        amplifiedStreamRef.current = destination.stream;

        // Jika AudioContext sudah running, langsung pasang track hasil penguatan 300% ke sender WebRTC yang aktif
        const attachAmplifiedTrackToActivePc = () => {
          if (
            pcRef.current &&
            destination.stream.getAudioTracks().length > 0
          ) {
            const ampTrack = destination.stream.getAudioTracks()[0];
            pcRef.current.getSenders().forEach((sender) => {
              if (!sender.track || sender.track.kind === 'audio') {
                sender.replaceTrack(ampTrack).catch(() => {});
              }
            });
          }
        };

        audioCtx.onstatechange = () => {
          if (audioCtx.state === 'running') {
            attachAmplifiedTrackToActivePc();
          }
        };

        // Meter RMS lokal untuk indikator modulasi suara
        const timeData = new Uint8Array(analyser.frequencyBinCount);
        const updateMeter = () => {
          if (
            isManualDisconnectedRef.current ||
            !rawStreamRef.current ||
            !rawStreamRef.current.active
          ) {
            return;
          }
          analyser.getByteTimeDomainData(timeData);
          let sum = 0;
          for (let i = 0; i < timeData.length; i++) {
            const norm = (timeData[i] - 128) / 128;
            sum += norm * norm;
          }
          const rms = Math.min(
            100,
            Math.round(Math.sqrt(sum / timeData.length) * 260)
          );
          setAudioRms(rms);
          requestAnimationFrame(updateMeter);
        };
        requestAnimationFrame(updateMeter);

        // Jalur Audio Fallback via WebSocket (SIGMA_WS_AUDIO) bila WebRTC ICE belum terbentuk
        try {
          const processor = audioCtx.createScriptProcessor(4096, 1, 1);
          const silentSink = audioCtx.createGain();
          silentSink.gain.value = 0;
          gainNode.connect(processor);
          processor.connect(silentSink);
          silentSink.connect(audioCtx.destination);

          processor.onaudioprocess = (audioEv) => {
            if (mutedRef.current || isManualDisconnectedRef.current) return;
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;

            const pc = pcRef.current;
            const isWebRtcConnected = Boolean(
              pc &&
                (pc.iceConnectionState === 'connected' ||
                  pc.iceConnectionState === 'completed')
            );
            if (isWebRtcConnected) return;

            const input = audioEv.inputBuffer.getChannelData(0);
            const inRate = audioCtx.sampleRate || 48000;
            const outRate = 16000;
            const ratio = Math.max(1, Math.round(inRate / outRate));
            const downsampled: number[] = [];
            for (let i = 0; i < input.length; i += ratio) {
              const s = Math.max(-1, Math.min(1, input[i]));
              downsampled.push(Math.round(s * 32767));
            }
            if (downsampled.length > 0) {
              ws.send(
                JSON.stringify({
                  type: 'SIGMA_WS_AUDIO',
                  senderId: clientId,
                  targetId: 'MASTER',
                  sampleRate: Math.round(inRate / ratio),
                  samples: downsampled,
                })
              );
            }
          };
        } catch {}

        if (
          audioCtx.state === 'running' &&
          destination.stream.getAudioTracks().length > 0
        ) {
          return destination.stream;
        }
      } catch {}

      return rawStream;
    })();

    micInFlightRef.current = acquireTask;
    try {
      return await acquireTask;
    } finally {
      micInFlightRef.current = null;
    }
  }, [clientId]);

  // Buat RTCPeerConnection + Transceiver sendonly + DataChannel 'tactical-telemetry' dengan sessionId unik
  const createClientPeerConnection = useCallback(
    (stream: MediaStream | null, sessionId: string): RTCPeerConnection => {
      if (pcRef.current) {
        console.log(
          `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Closing previous RTCPeerConnection before creating new session (${sessionId})`,
          {
            prevConnectionState: pcRef.current.connectionState,
            prevIceConnectionState: pcRef.current.iceConnectionState,
            prevSignalingState: pcRef.current.signalingState,
          }
        );
        try {
          pcRef.current.onicecandidate = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.oniceconnectionstatechange = null;
          pcRef.current.onsignalingstatechange = null;
          pcRef.current.onicegatheringstatechange = null;
          pcRef.current.close();
        } catch {}
      }

      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;
      currentSessionIdRef.current = sessionId;
      pendingCandidatesRef.current = [];
      isRemoteDescReadyRef.current = false;

      const activeStream =
        audioCtxRef.current?.state === 'running' &&
        amplifiedStreamRef.current &&
        amplifiedStreamRef.current.getAudioTracks().length > 0
          ? amplifiedStreamRef.current
          : stream || rawStreamRef.current;

      console.log(
        `[CLIENT-RTC][${clientId}][${sessionId}] Created RTCPeerConnection`,
        {
          hasAudioStream: Boolean(
            activeStream && activeStream.getAudioTracks().length > 0
          ),
          audioTracksCount: activeStream ? activeStream.getAudioTracks().length : 0,
          audioCtxState: audioCtxRef.current?.state || 'none',
          iceServers: RTC_CONFIG.iceServers,
        }
      );

      if (activeStream && activeStream.getAudioTracks().length > 0) {
        activeStream.getAudioTracks().forEach((track) => {
          track.enabled = !mutedRef.current;
          try {
            pc.addTransceiver(track, {
              direction: 'sendonly',
              streams: [activeStream],
            });
            console.log(
              `[CLIENT-RTC][${clientId}][${sessionId}] Added audio transceiver (sendonly) with track:`,
              { id: track.id, label: track.label, readyState: track.readyState }
            );
          } catch (transceiverErr) {
            console.warn(
              `[CLIENT-RTC][${clientId}][${sessionId}] addTransceiver failed, falling back to addTrack:`,
              transceiverErr
            );
            try {
              pc.addTrack(track, activeStream);
            } catch (addTrackErr) {
              console.error(
                `[CLIENT-RTC][${clientId}][${sessionId}] addTrack failed:`,
                addTrackErr
              );
            }
          }
        });
      } else {
        try {
          pc.addTransceiver('audio', { direction: 'sendonly' });
          console.log(
            `[CLIENT-RTC][${clientId}][${sessionId}] Added recv/sendonly placeholder audio transceiver (no mic track yet)`
          );
        } catch (err) {
          console.warn(
            `[CLIENT-RTC][${clientId}][${sessionId}] Failed to add placeholder audio transceiver:`,
            err
          );
        }
      }

      // Buat DataChannel 'tactical-telemetry' untuk pengiriman posisi GPS ke Master
      const dc = pc.createDataChannel('tactical-telemetry', {
        ordered: true,
      });
      dcRef.current = dc;

      dc.onopen = () => {
        console.log(
          `[CLIENT-RTC][${clientId}][${sessionId}] DataChannel 'tactical-telemetry' OPEN`,
          {
            readyState: dc.readyState,
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
          }
        );
        setPeerStatus('CONNECTED');
        setStatus('TERHUBUNG KE MASTER');
        transmitTelemetryPacket();
      };

      dc.onclose = () => {
        console.warn(
          `[CLIENT-RTC][${clientId}][${sessionId}] DataChannel 'tactical-telemetry' CLOSED`,
          {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
          }
        );
      };

      dc.onerror = (dcErr) => {
        console.error(
          `[CLIENT-RTC][${clientId}][${sessionId}] DataChannel 'tactical-telemetry' ERROR:`,
          dcErr
        );
      };

      dc.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as SignalingMessage;
          if (msg.type === 'SET_GAIN' && typeof msg.value === 'number') {
            setSensitivityGain(msg.value);
          } else if (msg.type === 'SET_MUTE') {
            setIsMuted(Boolean(msg.value));
          }
        } catch {}
      };

      // Kirim setiap ICE Candidate melalui jalur ganda (WebSocket + HTTP /api/signal) dengan sessionId
      pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (currentSessionIdRef.current !== sessionId) {
          console.warn(
            `[CLIENT-RTC][${clientId}][${sessionId}] Ignoring onicecandidate for stale session (active=${currentSessionIdRef.current})`
          );
          return;
        }
        if (event.candidate && event.candidate.candidate) {
          const candidateJson = event.candidate.toJSON();
          console.log(
            `[CLIENT-RTC][${clientId}][${sessionId}] onicecandidate -> Local ICE candidate generated, sending to MASTER:`,
            {
              type: event.candidate.type,
              protocol: event.candidate.protocol,
              address: event.candidate.address,
              port: event.candidate.port,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              candidate: event.candidate.candidate,
              iceGatheringState: pc.iceGatheringState,
              iceConnectionState: pc.iceConnectionState,
              connectionState: pc.connectionState,
              signalingState: pc.signalingState,
            }
          );
          void sendSignalingPacket({
            type: 'candidate',
            senderId: clientId,
            targetId: 'MASTER',
            sessionId,
            packetId: makePacketId('c-cand'),
            candidate: candidateJson,
            data: candidateJson,
          });
        } else {
          console.log(
            `[CLIENT-RTC][${clientId}][${sessionId}] onicecandidate -> ICE gathering complete (null candidate)`,
            {
              iceGatheringState: pc.iceGatheringState,
              iceConnectionState: pc.iceConnectionState,
              connectionState: pc.connectionState,
              signalingState: pc.signalingState,
            }
          );
        }
      };

      pc.onicegatheringstatechange = () => {
        if (pcRef.current !== pc) return;
        console.log(
          `[CLIENT-RTC][${clientId}][${sessionId}] onicegatheringstatechange -> ${pc.iceGatheringState}`,
          {
            iceGatheringState: pc.iceGatheringState,
            iceConnectionState: pc.iceConnectionState,
            connectionState: pc.connectionState,
            signalingState: pc.signalingState,
          }
        );
      };

      pc.onsignalingstatechange = () => {
        if (pcRef.current !== pc) return;
        console.log(
          `[CLIENT-RTC][${clientId}][${sessionId}] onsignalingstatechange -> ${pc.signalingState}`,
          {
            signalingState: pc.signalingState,
            iceConnectionState: pc.iceConnectionState,
            connectionState: pc.connectionState,
            iceGatheringState: pc.iceGatheringState,
          }
        );
      };

      pc.onicecandidateerror = (event: RTCPeerConnectionIceErrorEvent) => {
        console.warn(
          `[CLIENT-RTC][${clientId}][${sessionId}] onicecandidateerror:`,
          {
            errorCode: event.errorCode,
            errorText: event.errorText,
            url: event.url,
            address: event.address,
            port: event.port,
          }
        );
      };

      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        const st = pc.connectionState;
        const iceSt = pc.iceConnectionState;
        console.log(
          `[CLIENT-RTC][${clientId}][${sessionId}] onconnectionstatechange -> ${st}`,
          {
            connectionState: st,
            iceConnectionState: iceSt,
            iceGatheringState: pc.iceGatheringState,
            signalingState: pc.signalingState,
            dcReadyState: dcRef.current?.readyState || 'none',
          }
        );
        if (st === 'failed' || st === 'disconnected') {
          console.warn(
            `[CLIENT-RTC][${clientId}][${sessionId}] PeerConnection state degraded: ${st} (ice=${iceSt})`
          );
        }
        if (
          st === 'connected' ||
          iceSt === 'connected' ||
          iceSt === 'completed'
        ) {
          isHandshakingRef.current = false;
          setPeerStatus('CONNECTED');
          setStatus('TERHUBUNG KE MASTER');
          transmitTelemetryPacket();
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        const st = pc.connectionState;
        const iceSt = pc.iceConnectionState;
        console.log(
          `[CLIENT-RTC][${clientId}][${sessionId}] oniceconnectionstatechange -> ${iceSt}`,
          {
            iceConnectionState: iceSt,
            connectionState: st,
            iceGatheringState: pc.iceGatheringState,
            signalingState: pc.signalingState,
            dcReadyState: dcRef.current?.readyState || 'none',
          }
        );
        if (iceSt === 'failed' || iceSt === 'disconnected') {
          console.warn(
            `[CLIENT-RTC][${clientId}][${sessionId}] ICE Connection state degraded: ${iceSt} (conn=${st})`
          );
        }
        if (
          st === 'connected' ||
          iceSt === 'connected' ||
          iceSt === 'completed'
        ) {
          isHandshakingRef.current = false;
          setPeerStatus('CONNECTED');
          setStatus('TERHUBUNG KE MASTER');
          transmitTelemetryPacket();
        }
      };

      return pc;
    },
    [clientId, sendSignalingPacket, transmitTelemetryPacket]
  );

  // Kirim SDP Offer ke Master dengan sessionId yang cocok
  const sendOfferOverSignaling = useCallback(
    async (pc: RTCPeerConnection, sessionId: string) => {
      if (isManualDisconnectedRef.current) return;
      try {
        isHandshakingRef.current = true;
        lastOfferSentAtRef.current = Date.now();
        console.log(
          `[CLIENT-RTC][${clientId}][${sessionId}] Creating SDP Offer...`,
          {
            signalingState: pc.signalingState,
            iceConnectionState: pc.iceConnectionState,
            connectionState: pc.connectionState,
          }
        );
        const offer = await pc.createOffer();
        if (currentSessionIdRef.current !== sessionId) {
          console.warn(
            `[CLIENT-RTC][${clientId}][${sessionId}] Aborting Offer: session superseded by ${currentSessionIdRef.current}`
          );
          return;
        }
        await pc.setLocalDescription(offer);
        console.log(
          `[CLIENT-RTC][${clientId}][${sessionId}] setLocalDescription(offer) succeeded`,
          {
            signalingState: pc.signalingState,
            sdpLength: pc.localDescription?.sdp?.length || 0,
          }
        );

        if (pc.localDescription && currentSessionIdRef.current === sessionId) {
          const sdpObj = {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp,
          };
          const packetId = makePacketId('c-off');
          console.log(
            `[CLIENT-RTC][${clientId}][${sessionId}] Dispatching SDP Offer to MASTER (packetId=${packetId})`
          );
          await sendSignalingPacket({
            type: 'offer',
            senderId: clientId,
            targetId: 'MASTER',
            sessionId,
            packetId,
            sdp: sdpObj,
            data: sdpObj,
          });
        }
      } catch (err) {
        console.error(
          `[CLIENT-RTC][${clientId}][${sessionId}] Gagal membuat/mengirim Offer:`,
          err
        );
      } finally {
        setTimeout(() => {
          isHandshakingRef.current = false;
        }, 1000);
      }
    },
    [clientId, sendSignalingPacket]
  );

  // Mulai atau perbarui negosiasi WebRTC secara terkendali (tanpa double-offer race condition)
  const startWebRTC = useCallback(
    async (forceReset: boolean = false) => {
      if (isManualDisconnectedRef.current) return;

      const existingPc = pcRef.current;
      if (!forceReset && existingPc) {
        const isAlreadyConnected =
          existingPc.connectionState === 'connected' ||
          existingPc.iceConnectionState === 'connected' ||
          existingPc.iceConnectionState === 'completed';

        if (isAlreadyConnected) {
          // Jika mikrofon sudah ada namun belum terpasang ke transceiver, pasang dengan replaceTrack tanpa menutup koneksi!
          const bestStream =
            audioCtxRef.current?.state === 'running' &&
            amplifiedStreamRef.current &&
            amplifiedStreamRef.current.getAudioTracks().length > 0
              ? amplifiedStreamRef.current
              : rawStreamRef.current;
          if (bestStream && bestStream.getAudioTracks().length > 0) {
            const track = bestStream.getAudioTracks()[0];
            existingPc.getSenders().forEach((sender) => {
              if (!sender.track || sender.track.kind === 'audio') {
                sender.replaceTrack(track).catch(() => {});
              }
            });
          }
          setPeerStatus('CONNECTED');
          setStatus('TERHUBUNG KE MASTER');
          return;
        }

        const timeSinceLastOffer = Date.now() - lastOfferSentAtRef.current;
        if (
          timeSinceLastOffer < 10000 &&
          (existingPc.iceConnectionState === 'checking' ||
            existingPc.connectionState === 'connecting' ||
            existingPc.signalingState === 'have-local-offer')
        ) {
          console.log(
            `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Skipping startWebRTC: handshake already in progress (${timeSinceLastOffer}ms ago)`,
            {
              signalingState: existingPc.signalingState,
              iceConnectionState: existingPc.iceConnectionState,
              connectionState: existingPc.connectionState,
            }
          );
          return;
        }
      }

      if (isHandshakingRef.current && !forceReset) return;
      isHandshakingRef.current = true;

      try {
        const stream =
          rawStreamRef.current ||
          (await Promise.race([
            ensureMicrophoneStream(),
            new Promise<MediaStream | null>((resolve) =>
              setTimeout(() => resolve(rawStreamRef.current), 1800)
            ),
          ]));

        const newSessionId = `sess-${Date.now()}-${Math.random()
          .toString(36)
          .substring(2, 7)}`;
        console.log(
          `[CLIENT-RTC][${clientId}] Starting new WebRTC negotiation session: ${newSessionId} (forceReset=${forceReset})`
        );
        const pc = createClientPeerConnection(stream, newSessionId);
        await sendOfferOverSignaling(pc, newSessionId);
      } catch (err) {
        console.error('[CLIENT-RTC] Error di dalam startWebRTC():', err);
      } finally {
        setTimeout(() => {
          isHandshakingRef.current = false;
        }, 800);
      }
    },
    [
      clientId,
      createClientPeerConnection,
      ensureMicrophoneStream,
      sendOfferOverSignaling,
    ]
  );

  // Proses pesan masuk dari Master (via WebSocket maupun HTTP Polling)
  const processIncomingSignalingMessage = useCallback(
    async (data: SignalingMessage) => {
      if (!data || !data.type || isManualDisconnectedRef.current) return;
      if (data.targetId && data.targetId !== clientId) return;

      if (typeof data.packetId === 'string' && data.packetId) {
        if (seenPacketIdsRef.current.has(data.packetId)) return;
        seenPacketIdsRef.current.add(data.packetId);
        if (seenPacketIdsRef.current.size > 1000) {
          const first = seenPacketIdsRef.current.values().next().value;
          if (first) seenPacketIdsRef.current.delete(first);
        }
      }

      if (data.type === 'master_ack') {
        setPeerStatus('CONNECTED');
        setStatus('TERHUBUNG KE MASTER');
        return;
      }

      if (data.type === 'master_online') {
        console.log(
          `[CLIENT-RTC][${clientId}] Received 'master_online' signal from MASTER`,
          {
            activeSessionId: currentSessionIdRef.current,
            connectionState: pcRef.current?.connectionState || 'none',
            iceConnectionState: pcRef.current?.iceConnectionState || 'none',
          }
        );
        setPeerStatus('CONNECTED');
        setStatus('TERHUBUNG KE MASTER');
        const pc = pcRef.current;
        const alreadyActive =
          pc &&
          (pc.connectionState === 'connected' ||
            pc.iceConnectionState === 'connected' ||
            pc.iceConnectionState === 'completed' ||
            (Date.now() - lastOfferSentAtRef.current < 4000 &&
              (pc.iceConnectionState === 'checking' ||
                pc.signalingState === 'have-local-offer')));
        if (!alreadyActive) {
          void startWebRTC(true);
        }
        return;
      }

      // Validasi sessionId agar Answer/Candidate sesi lama tidak pernah merusak sesi RTCPeerConnection baru
      if (
        data.sessionId &&
        currentSessionIdRef.current &&
        data.sessionId !== currentSessionIdRef.current
      ) {
        console.warn(
          `[CLIENT-RTC][${clientId}] Dropping signaling message (${data.type}) with mismatched sessionId: incoming=${data.sessionId}, active=${currentSessionIdRef.current}`
        );
        return;
      }

      const sdpPayload = (data.sdp || data.data) as
        | RTCSessionDescriptionInit
        | undefined;
      if (
        (data.type === 'answer' || data.type === 'ANSWER') &&
        sdpPayload &&
        sdpPayload.sdp &&
        pcRef.current
      ) {
        try {
          const pc = pcRef.current;
          console.log(
            `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Received SDP Answer from MASTER`,
            {
              incomingSessionId: data.sessionId,
              packetId: data.packetId,
              signalingState: pc.signalingState,
              iceConnectionState: pc.iceConnectionState,
              connectionState: pc.connectionState,
              queuedCandidatesCount: pendingCandidatesRef.current.length,
            }
          );
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(
              new RTCSessionDescription(sdpPayload)
            );
            isRemoteDescReadyRef.current = true;
            console.log(
              `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] setRemoteDescription(answer) succeeded`,
              {
                signalingState: pc.signalingState,
                iceConnectionState: pc.iceConnectionState,
                connectionState: pc.connectionState,
              }
            );
            setPeerStatus('CONNECTED');
            setStatus('TERHUBUNG KE MASTER');

            const queue = pendingCandidatesRef.current;
            if (queue.length > 0) {
              console.log(
                `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Draining ${queue.length} queued remote ICE candidates from MASTER`
              );
            }
            while (queue.length > 0) {
              const cand = queue.shift();
              if (cand && cand.candidate) {
                await pc
                  .addIceCandidate(new RTCIceCandidate(cand))
                  .then(() => {
                    console.log(
                      `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Applied queued remote ICE candidate:`,
                      cand.candidate
                    );
                  })
                  .catch((candErr) => {
                    console.warn(
                      `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Failed to apply queued remote ICE candidate:`,
                      candErr
                    );
                  });
              }
            }
            transmitTelemetryPacket();
          } else {
            console.warn(
              `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Ignored SDP Answer because signalingState is '${pc.signalingState}' (expected 'have-local-offer')`
            );
          }
        } catch (err) {
          console.error(
            `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Gagal setRemoteDescription(answer):`,
            err
          );
        }
        return;
      }

      const candidatePayload = (data.candidate || data.data) as
        | RTCIceCandidateInit
        | undefined;
      if (
        (data.type === 'candidate' || data.type === 'ICE_CANDIDATE') &&
        candidatePayload &&
        candidatePayload.candidate &&
        pcRef.current
      ) {
        try {
          const pc = pcRef.current;
          if (
            pc.remoteDescription &&
            pc.remoteDescription.type &&
            isRemoteDescReadyRef.current
          ) {
            await pc.addIceCandidate(new RTCIceCandidate(candidatePayload));
            console.log(
              `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Added remote ICE candidate from MASTER immediately:`,
              {
                candidate: candidatePayload.candidate,
                sdpMid: candidatePayload.sdpMid,
                sdpMLineIndex: candidatePayload.sdpMLineIndex,
                iceConnectionState: pc.iceConnectionState,
                connectionState: pc.connectionState,
              }
            );
          } else {
            pendingCandidatesRef.current.push(candidatePayload);
            console.log(
              `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] Queued remote ICE candidate from MASTER (remoteDescription not ready yet, queueSize=${pendingCandidatesRef.current.length}):`,
              candidatePayload.candidate
            );
          }
        } catch (candErr) {
          console.warn(
            `[CLIENT-RTC][${clientId}][${currentSessionIdRef.current}] addIceCandidate error:`,
            candErr
          );
        }
        return;
      }

      if (data.type === 'SET_GAIN' && typeof data.value === 'number') {
        setSensitivityGain(data.value);
      } else if (data.type === 'SET_MUTE') {
        setIsMuted(Boolean(data.value));
      }
    },
    [clientId, startWebRTC, transmitTelemetryPacket]
  );

  // Siklus Utama Koneksi Otomatis ke Master (Stabil, Tanpa Race Condition)
  useEffect(() => {
    let isMounted = true;
    let wsReconnectTimer: number | null = null;
    let autoOfferInterval: number | null = null;
    let httpPollInterval: number | null = null;

    const connectSignalingWebSocket = () => {
      if (!isMounted || isManualDisconnectedRef.current) return;
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      try {
        const ws = new WebSocket(getSignalingWebSocketUrl());
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted || isManualDisconnectedRef.current) return;
          setPeerStatus('CONNECTED');
          setStatus('TERHUBUNG KE MASTER');

          ws.send(
            JSON.stringify({
              type: 'register',
              id: clientId,
              senderId: clientId,
              targetId: 'MASTER',
              packetId: makePacketId('c-reg-ws'),
            })
          );
          transmitTelemetryPacket();

          // Hanya jalankan startWebRTC bila bootstrap awal sudah selesai dan belum ada PC aktif
          if (!isBootstrappingRef.current && !pcRef.current) {
            void startWebRTC(false);
          }
        };

        ws.onmessage = async (event) => {
          if (!isMounted || isManualDisconnectedRef.current) return;
          try {
            const msg = JSON.parse(event.data) as SignalingMessage;
            await processIncomingSignalingMessage(msg);
          } catch {}
        };

        ws.onclose = () => {
          if (!isMounted) return;
          if (isManualDisconnectedRef.current) {
            setPeerStatus('DISCONNECTED');
            setStatus('TRANSMISI DIHENTIKAN (STANDBY)');
            return;
          }
          wsReconnectTimer = window.setTimeout(connectSignalingWebSocket, 2000);
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {}
        };
      } catch {
        if (!isManualDisconnectedRef.current) {
          wsReconnectTimer = window.setTimeout(connectSignalingWebSocket, 2500);
        }
      }
    };

    connectWsFnRef.current = connectSignalingWebSocket;

    const bootstrapClientConnection = async () => {
      if (isManualDisconnectedRef.current) return;
      isBootstrappingRef.current = true;

      // 1. Daftarkan Klien via HTTP + WebSocket dan kirim telemetri awal
      void sendSignalingPacket({
        type: 'register',
        id: clientId,
        senderId: clientId,
        targetId: 'MASTER',
        packetId: makePacketId('c-reg-http'),
      });
      connectSignalingWebSocket();
      transmitTelemetryPacket();

      // 2. Akuisisi mikrofon + GainNode 300% (batas waktu 2.5 detik agar tidak pernah memblokir koneksi)
      await ensureMicrophoneStream();
      isBootstrappingRef.current = false;
      if (!isMounted || isManualDisconnectedRef.current) return;

      // 3. Buat SATU RTCPeerConnection dengan sessionId unik dan kirim SDP Offer ke Master
      await startWebRTC(true);

      // 4. Polling HTTP /api/signal/:clientId setiap 1.5 detik untuk menerima Answer & Candidate
      httpPollInterval = window.setInterval(async () => {
        if (!isMounted || isManualDisconnectedRef.current) return;
        try {
          const res = await fetch(`/api/signal/${encodeURIComponent(clientId)}`);
          if (!res.ok) return;
          const payload = (await res.json()) as {
            ok?: boolean;
            messages?: SignalingMessage[];
          };
          if (payload.ok && !isManualDisconnectedRef.current) {
            setPeerStatus('CONNECTED');
            setStatus('TERHUBUNG KE MASTER');
          }
          if (Array.isArray(payload.messages)) {
            for (const msg of payload.messages) {
              await processIncomingSignalingMessage(msg);
            }
          }
        } catch {}
      }, 1500);

      // 5. Heartbeat telemetri & pemulihan koneksi setiap 6 detik (TIDAK memutus PC yang sudah connected!)
      autoOfferInterval = window.setInterval(async () => {
        if (!isMounted || isManualDisconnectedRef.current) return;
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          connectSignalingWebSocket();
        }
        transmitTelemetryPacket();

        const pcCurrent = pcRef.current;
        const isPcHealthy = Boolean(
          pcCurrent &&
            (pcCurrent.connectionState === 'connected' ||
              pcCurrent.iceConnectionState === 'connected' ||
              pcCurrent.iceConnectionState === 'completed' ||
              (Date.now() - lastOfferSentAtRef.current < 10000 &&
                (pcCurrent.iceConnectionState === 'checking' ||
                  pcCurrent.connectionState === 'connecting' ||
                  pcCurrent.signalingState === 'have-local-offer')))
        );

        if (!isPcHealthy) {
          await startWebRTC(true);
        }
      }, 6000);
    };

    void bootstrapClientConnection();

    // Unlock AudioContext & mikrofon otomatis saat pengguna menyentuh layar
    const unlockOnTouch = () => {
      if (isManualDisconnectedRef.current) return;
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      if (!rawStreamRef.current || !rawStreamRef.current.active) {
        ensureMicrophoneStream()
          .then((s) => {
            if (s && isMounted && !isManualDisconnectedRef.current) {
              const pc = pcRef.current;
              const bestTrack =
                (amplifiedStreamRef.current?.getAudioTracks()[0]) ||
                s.getAudioTracks()[0];
              if (
                pc &&
                (pc.iceConnectionState === 'connected' ||
                  pc.iceConnectionState === 'completed') &&
                bestTrack
              ) {
                pc.getSenders().forEach((sender) => {
                  if (!sender.track || sender.track.kind === 'audio') {
                    sender.replaceTrack(bestTrack).catch(() => {});
                  }
                });
              } else {
                void startWebRTC(true);
              }
            }
          })
          .catch(() => {});
      }
    };
    window.addEventListener('pointerdown', unlockOnTouch, { passive: true });

    return () => {
      isMounted = false;
      window.removeEventListener('pointerdown', unlockOnTouch);
      if (autoOfferInterval) clearInterval(autoOfferInterval);
      if (httpPollInterval) clearInterval(httpPollInterval);
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {}
      }
    };
  }, [
    clientId,
    ensureMicrophoneStream,
    processIncomingSignalingMessage,
    sendSignalingPacket,
    startWebRTC,
    transmitTelemetryPacket,
  ]);

  // Pelacakan GPS Real-Time (watchPosition + interval 10 detik)
  useEffect(() => {
    if (!('geolocation' in navigator)) return;

    let watchId: number | null = null;

    const fetchGps = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const nextCoords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            alt:
              pos.coords.altitude !== null
                ? Math.round(pos.coords.altitude)
                : null,
            accuracy: Math.max(1, Math.round(pos.coords.accuracy)),
            speed:
              pos.coords.speed !== null
                ? Math.round(pos.coords.speed * 3.6)
                : null,
            lastUpdated: Date.now(),
          };
          setGpsCoords(nextCoords);
          transmitTelemetryPacket(nextCoords);
        },
        () => {
          transmitTelemetryPacket();
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    };

    fetchGps();

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const nextCoords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          alt:
            pos.coords.altitude !== null
              ? Math.round(pos.coords.altitude)
              : null,
          accuracy: Math.max(1, Math.round(pos.coords.accuracy)),
          speed:
            pos.coords.speed !== null
              ? Math.round(pos.coords.speed * 3.6)
              : null,
          lastUpdated: Date.now(),
        };
        setGpsCoords(nextCoords);
        transmitTelemetryPacket(nextCoords);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );

    const intervalId = window.setInterval(fetchGps, 10000);

    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
      clearInterval(intervalId);
    };
  }, [transmitTelemetryPacket]);

  // Tombol Manual Mulai / Re-Konek Transmisi
  const handleManualConnect = useCallback(async () => {
    isManualDisconnectedRef.current = false;
    isHandshakingRef.current = false;
    lastOfferSentAtRef.current = 0;

    setPeerStatus('CONNECTED');
    setStatus('TERHUBUNG KE MASTER');
    requestWakeLock();

    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }

    if (
      !wsRef.current ||
      wsRef.current.readyState === WebSocket.CLOSED ||
      wsRef.current.readyState === WebSocket.CLOSING
    ) {
      wsRef.current = null;
      connectWsFnRef.current?.();
    }

    void sendSignalingPacket({
      type: 'register',
      id: clientId,
      senderId: clientId,
      targetId: 'MASTER',
      packetId: makePacketId('c-reg-manual'),
    });
    transmitTelemetryPacket();

    await ensureMicrophoneStream();
    if (isManualDisconnectedRef.current) return;

    await startWebRTC(true);
  }, [
    clientId,
    ensureMicrophoneStream,
    requestWakeLock,
    sendSignalingPacket,
    startWebRTC,
    transmitTelemetryPacket,
  ]);

  // Tombol Manual Hentikan Transmisi
  const handleManualDisconnect = useCallback(() => {
    isManualDisconnectedRef.current = true;
    isHandshakingRef.current = false;
    setPeerStatus('DISCONNECTED');
    setStatus('TRANSMISI DIHENTIKAN (STANDBY)');
    setAudioRms(0);

    const disconnectMsg = {
      type: 'client_disconnected',
      senderId: clientId,
      targetId: 'MASTER',
      packetId: makePacketId('c-disc'),
    };

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify(disconnectMsg));
      } catch {}
    }
    void fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(disconnectMsg),
    }).catch(() => {});

    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {}
      dcRef.current = null;
    }

    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
  }, [clientId]);

  return (
    <div className="min-h-screen bg-[#031525] text-[#dff8ff] flex flex-col justify-between p-4 sm:p-6 select-none">
      {/* Top Bar */}
      <header className="flex items-center justify-between gap-4 border-b border-[#19d3ff]/25 pb-3.5">
        <div className="flex items-center gap-2.5 shrink-0">
          <img
            src={LOGO_TNI_AU}
            alt="Logo TNI AU"
            referrerPolicy="no-referrer"
            className="w-7 h-7 object-contain rounded-full border border-[#19d3ff]/40 bg-[#020e1a] p-0.5 shrink-0"
          />
          <span className="font-display-tactical text-lg sm:text-xl font-bold tracking-wider text-[#66ecff] whitespace-nowrap">
            S.I.G.M.A DISKOMLEKAU
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onExit}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#041d34] hover:bg-[#072b4d] border border-[#19d3ff]/40 text-[#dff8ff] rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-[#19d3ff]" />
            <span>MENU UTAMA</span>
          </button>
          <img
            src={LOGO_PETIR}
            alt="Logo Diskomlekau"
            referrerPolicy="no-referrer"
            className="w-7 h-7 object-contain rounded-full border border-[#19d3ff]/40 bg-[#020e1a] p-0.5 shrink-0"
          />
        </div>
      </header>

      {/* Main Transmitter Unit Workspace */}
      <main className="my-auto max-w-lg w-full mx-auto space-y-4 py-4">
        {/* Status & Node ID Card */}
        <section className="border border-[#19d3ff]/35 bg-[#041d34]/90 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-mono-tactical text-[#66ecff] font-semibold">
              <Radio className="w-3.5 h-3.5 text-[#19d3ff]" />
              <span>CLIENT TRANSMITTER NODE</span>
            </span>
            <span
              className={`font-mono-tactical font-bold ${
                peerStatus === 'CONNECTED'
                  ? 'text-emerald-400'
                  : peerStatus === 'DISCONNECTED'
                  ? 'text-rose-400'
                  : 'text-amber-300'
              }`}
            >
              {status}
            </span>
          </div>

          <div className="text-center py-2 space-y-1">
            <div className="text-xs text-slate-400">IDENTITAS SENSOR KLIEN</div>
            <div className="font-mono-tactical text-3xl sm:text-4xl font-bold tracking-widest text-[#dff8ff] tabular-nums">
              {clientId}
            </div>
            <div className="text-xs text-slate-300">
              Target Koneksi:{' '}
              <span className="font-mono-tactical text-[#66ecff]">MASTER</span> ·
              Status Mic:{' '}
              <span className="font-mono-tactical text-emerald-300">
                {micStatus === 'READY'
                  ? 'AKTIF (SENDONLY)'
                  : micStatus === 'DENIED'
                  ? 'KETUK TOMBOL KONEK U/ IZIN MIC'
                  : 'MENYIAPKAN...'}
              </span>
            </div>
          </div>

          {/* Primary Start / Stop Controls */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleManualConnect()}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded font-bold text-xs tracking-wider bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400 text-emerald-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Power className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>
                {peerStatus === 'CONNECTED' ? 'RE-KONEK MASTER' : 'KONEK MASTER'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleManualDisconnect}
              disabled={peerStatus === 'DISCONNECTED'}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded font-bold text-xs tracking-wider bg-rose-500/20 hover:bg-rose-500/35 border border-rose-400 text-rose-200 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
            >
              <PowerOff className="w-4 h-4 text-rose-400 shrink-0" />
              <span>DISKONEK</span>
            </button>
          </div>
        </section>

        {/* High-Sensitivity Audio Gain Control (Default 300% / 3.0x) */}
        <section className="border border-[#19d3ff]/30 bg-[#041d34]/80 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 font-semibold text-[#66ecff]">
              <Sliders className="w-4 h-4 text-[#19d3ff]" />
              <span>SENSITIVITAS AUDIO (GAINNODE)</span>
            </div>
            <span className="font-mono-tactical font-bold text-emerald-300 tabular-nums">
              {Math.round(sensitivityGain * 100)}% ({sensitivityGain.toFixed(1)}x)
            </span>
          </div>

          <input
            type="range"
            min="1.0"
            max="5.0"
            step="0.5"
            value={sensitivityGain}
            onChange={(e) => setSensitivityGain(parseFloat(e.target.value))}
            className="w-full accent-[#19d3ff] cursor-pointer"
          />

          <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono-tactical">
            <span>100% (1.0x)</span>
            <span>300% (3.0x Default)</span>
            <span>500% (5.0x Maks)</span>
          </div>

          {/* Live Microphone Modulation Meter */}
          <div className="pt-2 space-y-1.5 border-t border-[#19d3ff]/15">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-slate-300">
                <Mic className="w-3.5 h-3.5 text-[#19d3ff]" />
                <span>Level Modulasi Suara Keluar</span>
              </span>
              <span className="font-mono-tactical text-[#66ecff] tabular-nums">
                {audioRms}%
              </span>
            </div>
            <div className="w-full h-2 bg-[#020e1a] rounded overflow-hidden">
              <div
                className="h-full bg-[#19d3ff] transition-all duration-75"
                style={{ width: `${Math.min(100, audioRms)}%` }}
              />
            </div>
          </div>
        </section>

        {/* Live GPS Telemetry Status (`tactical-telemetry`) */}
        <section className="border border-[#19d3ff]/30 bg-[#041d34]/80 rounded-lg p-4 space-y-2.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 font-semibold text-[#66ecff]">
              <Navigation className="w-4 h-4 text-[#19d3ff]" />
              <span>POSISI GPS REAL-TIME (DATA CHANNEL)</span>
            </span>
            <span className="font-mono-tactical text-[11px] text-slate-400">
              tactical-telemetry
            </span>
          </div>

          {gpsCoords.lat !== null && gpsCoords.lng !== null ? (
            <div className="grid grid-cols-2 gap-2.5 pt-1 font-mono-tactical text-[#dff8ff] tabular-nums">
              <div className="bg-[#020e1a]/80 p-2.5 rounded border border-[#19d3ff]/20">
                <div className="text-[10px] text-slate-400">LATITUDE</div>
                <div className="font-semibold">{gpsCoords.lat.toFixed(6)}°</div>
              </div>
              <div className="bg-[#020e1a]/80 p-2.5 rounded border border-[#19d3ff]/20">
                <div className="text-[10px] text-slate-400">LONGITUDE</div>
                <div className="font-semibold">{gpsCoords.lng.toFixed(6)}°</div>
              </div>
              <div className="bg-[#020e1a]/80 p-2.5 rounded border border-[#19d3ff]/20">
                <div className="text-[10px] text-slate-400">AKURASI GPS</div>
                <div className="font-semibold">
                  {gpsCoords.accuracy !== null ? `±${gpsCoords.accuracy} m` : 'N/A'}
                </div>
              </div>
              <div className="bg-[#020e1a]/80 p-2.5 rounded border border-[#19d3ff]/20">
                <div className="text-[10px] text-slate-400">BATERAI PERANGKAT</div>
                <div className="font-semibold flex items-center gap-1.5">
                  <BatteryCharging className="w-3.5 h-3.5 text-[#19d3ff]" />
                  <span>
                    {batteryInfo.level !== null ? `${batteryInfo.level}%` : 'Aktif'}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-2 text-slate-400">
              Mengambil titik koordinat GPS presisi tinggi dari perangkat...
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#19d3ff]/20 pt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-[#19d3ff]" />
          <span>S.I.G.M.A DISKOMLEKAU · ONE-WAY AUDIO &amp; GPS TELEMETRY</span>
        </div>
        <div className="flex items-center gap-2 font-mono-tactical">
          <Activity className="w-3.5 h-3.5 text-[#19d3ff]" />
          <span>EC: OFF · NS: OFF · AGC: OFF</span>
        </div>
      </footer>
    </div>
  );
};

export default Client;
