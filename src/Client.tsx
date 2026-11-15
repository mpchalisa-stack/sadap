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

export const Client: React.FC<ClientProps> = ({
  onExit,
  initialNodeId,
}) => {
  const [clientId] = useState<string>(() => {
    if (initialNodeId) return initialNodeId;
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `SENSOR-${randomSuffix}`;
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
  const rawStreamRef = useRef<MediaStream | null>(null);
  const amplifiedStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const isRemoteDescReadyRef = useRef<boolean>(false);
  const isHandshakingRef = useRef<boolean>(false);
  const isManualDisconnectedRef = useRef<boolean>(false);
  const lastOfferSentAtRef = useRef<number>(0);
  const micInFlightRef = useRef<Promise<MediaStream | null> | null>(null);
  const connectWsFnRef = useRef<(() => void) | null>(null);

  const gpsRef = useRef(gpsCoords);
  const batteryRef = useRef(batteryInfo);
  const rmsRef = useRef(audioRms);
  const gainValueRef = useRef(sensitivityGain);
  const mutedRef = useRef(isMuted);

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

  // Kirim sinyal via HTTP (/api/signal) sebagai jalur cadangan anti-gagal
  const postHttpSignal = useCallback(async (packet: Record<string, unknown>) => {
    if (isManualDisconnectedRef.current) return;
    try {
      const res = await fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet),
      });
      if (res.ok && !isManualDisconnectedRef.current) {
        setPeerStatus('CONNECTED');
        setStatus('TERHUBUNG KE MASTER');
      }
    } catch {}
  }, []);

  // Fungsi kirim Telemetri GPS & Status ke Master via DataChannel ('tactical-telemetry'), WebSocket, & HTTP
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

      let sentViaWsOrDc = false;

      // 1. Kirim via RTCDataChannel ('tactical-telemetry')
      if (dcRef.current && dcRef.current.readyState === 'open') {
        try {
          dcRef.current.send(JSON.stringify(gpsUpdatePacket));
          dcRef.current.send(JSON.stringify(sigmaTelemetryPacket));
          sentViaWsOrDc = true;
        } catch {}
      }

      // 2. Kirim via WebSocket Signaling
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(
            JSON.stringify({
              ...sigmaTelemetryPacket,
              senderId: clientId,
              targetId: 'MASTER',
            })
          );
          sentViaWsOrDc = true;
        } catch {}
      }

      // 3. Kirim via HTTP /api/signal agar Master selalu menerima posisi & status klien
      if (!sentViaWsOrDc || peerStatus !== 'CONNECTED') {
        void postHttpSignal({
          ...sigmaTelemetryPacket,
          senderId: clientId,
          targetId: 'MASTER',
        });
      }
    },
    [clientId, peerStatus, postHttpSignal]
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
        // Coba constraint audio taktis (EC: false, NS: false, AGC: false) dengan batas waktu 3.5 detik agar tidak hang
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
            setTimeout(() => resolve(null), 3500)
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

      // Setup AudioContext + GainNode (3.0x / 300%) tanpa await resume() agar tidak pernah hang di browser seluler
      try {
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new AudioContextClass();
        audioCtxRef.current = audioCtx;

        // Jangan gunakan await di sini karena mobile browser akan menahan Promise resume() sampai layar disentuh
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

        // Bila AudioContext beralih ke running, pastikan sender WebRTC memakai track yang telah diperkuat 300%
        audioCtx.onstatechange = () => {
          if (
            audioCtx.state === 'running' &&
            pcRef.current &&
            destination.stream.getAudioTracks().length > 0
          ) {
            const ampTrack = destination.stream.getAudioTracks()[0];
            pcRef.current.getSenders().forEach((sender) => {
              if (sender.track && sender.track.kind === 'audio') {
                sender.replaceTrack(ampTrack).catch(() => {});
              }
            });
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

        // Jalur Audio Fallback via WebSocket (SIGMA_WS_AUDIO) jika UDP WebRTC terhambat
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

  // Buat RTCPeerConnection + Transceiver sendonly + DataChannel 'tactical-telemetry'
  const createClientPeerConnection = useCallback(
    (stream: MediaStream | null): RTCPeerConnection => {
      if (pcRef.current) {
        try {
          pcRef.current.onicecandidate = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.oniceconnectionstatechange = null;
          pcRef.current.close();
        } catch {}
      }

      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;
      pendingCandidatesRef.current = [];
      isRemoteDescReadyRef.current = false;

      // Pilih stream yang sudah diperkuat GainNode 300% jika AudioContext sudah running, atau rawStream
      const activeStream =
        audioCtxRef.current?.state === 'running' &&
        amplifiedStreamRef.current &&
        amplifiedStreamRef.current.getAudioTracks().length > 0
          ? amplifiedStreamRef.current
          : stream || rawStreamRef.current;

      if (activeStream && activeStream.getAudioTracks().length > 0) {
        activeStream.getAudioTracks().forEach((track) => {
          track.enabled = !mutedRef.current;
          try {
            pc.addTransceiver(track, {
              direction: 'sendonly',
              streams: [activeStream],
            });
          } catch {
            try {
              pc.addTrack(track, activeStream);
            } catch {}
          }
        });
      } else {
        try {
          pc.addTransceiver('audio', { direction: 'sendonly' });
        } catch {}
      }

      // Buat DataChannel 'tactical-telemetry' untuk pengiriman posisi GPS ke Master
      const dc = pc.createDataChannel('tactical-telemetry', {
        ordered: true,
      });
      dcRef.current = dc;

      dc.onopen = () => {
        setPeerStatus('CONNECTED');
        setStatus('TERHUBUNG KE MASTER');
        transmitTelemetryPacket();
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

      pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate && event.candidate.candidate) {
          const candidateJson = event.candidate.toJSON();
          const candidatePacket = {
            type: 'candidate',
            senderId: clientId,
            targetId: 'MASTER',
            candidate: candidateJson,
            data: candidateJson,
          };
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(candidatePacket));
          } else {
            void postHttpSignal(candidatePacket);
          }
        }
      };

      const checkConnState = () => {
        const st = pc.connectionState;
        const iceSt = pc.iceConnectionState;
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

      pc.onconnectionstatechange = checkConnState;
      pc.oniceconnectionstatechange = checkConnState;

      return pc;
    },
    [clientId, postHttpSignal, transmitTelemetryPacket]
  );

  // Kirim SDP Offer ke Master via WebSocket DAN HTTP (/api/signal)
  const sendOfferOverSignaling = useCallback(
    async (pc: RTCPeerConnection) => {
      if (isManualDisconnectedRef.current) return;
      try {
        isHandshakingRef.current = true;
        lastOfferSentAtRef.current = Date.now();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (pc.localDescription) {
          const sdpObj = {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp,
          };
          const offerPacket = {
            type: 'offer',
            senderId: clientId,
            targetId: 'MASTER',
            sdp: sdpObj,
            data: sdpObj,
          };

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(offerPacket));
          }
          await postHttpSignal(offerPacket);
        }
      } catch (err) {
        console.error('[CLIENT] Gagal membuat/mengirim Offer:', err);
      } finally {
        setTimeout(() => {
          isHandshakingRef.current = false;
        }, 1200);
      }
    },
    [clientId, postHttpSignal]
  );

  // Mulai atau ulangi negosiasi WebRTC
  const startWebRTC = useCallback(async () => {
    if (isManualDisconnectedRef.current) return;
    const existingPc = pcRef.current;
    const hasAudioSender = Boolean(
      existingPc &&
        existingPc
          .getSenders()
          .some(
            (s) =>
              s.track &&
              s.track.kind === 'audio' &&
              s.track.readyState === 'live'
          )
    );

    if (
      existingPc &&
      hasAudioSender &&
      (existingPc.connectionState === 'connected' ||
        existingPc.iceConnectionState === 'connected' ||
        existingPc.iceConnectionState === 'completed')
    ) {
      setPeerStatus('CONNECTED');
      setStatus('TERHUBUNG KE MASTER');
      return;
    }

    const timeSinceLastOffer = Date.now() - lastOfferSentAtRef.current;
    if (
      existingPc &&
      hasAudioSender &&
      timeSinceLastOffer < 7000 &&
      (existingPc.iceConnectionState === 'checking' ||
        existingPc.connectionState === 'connecting' ||
        existingPc.signalingState === 'have-local-offer')
    ) {
      return;
    }

    if (isHandshakingRef.current) return;
    isHandshakingRef.current = true;

    try {
      const stream =
        rawStreamRef.current ||
        (await Promise.race([
          ensureMicrophoneStream(),
          new Promise<MediaStream | null>((resolve) =>
            setTimeout(() => resolve(rawStreamRef.current), 1500)
          ),
        ]));

      const pc = createClientPeerConnection(stream);
      await sendOfferOverSignaling(pc);
    } catch {} finally {
      setTimeout(() => {
        isHandshakingRef.current = false;
      }, 1000);
    }
  }, [createClientPeerConnection, ensureMicrophoneStream, sendOfferOverSignaling]);

  // Proses pesan masuk dari Master (via WebSocket maupun HTTP Polling)
  const processIncomingSignalingMessage = useCallback(
    async (data: SignalingMessage) => {
      if (!data || !data.type || isManualDisconnectedRef.current) return;
      if (data.targetId && data.targetId !== clientId) return;

      if (data.type === 'master_ack') {
        setPeerStatus('CONNECTED');
        setStatus('TERHUBUNG KE MASTER');
        return;
      }

      if (data.type === 'master_online') {
        setPeerStatus('CONNECTED');
        setStatus('TERHUBUNG KE MASTER');
        const pc = pcRef.current;
        const alreadyActive =
          pc &&
          (pc.connectionState === 'connected' ||
            pc.iceConnectionState === 'connected' ||
            pc.iceConnectionState === 'completed' ||
            pc.iceConnectionState === 'checking' ||
            pc.signalingState === 'have-local-offer');
        if (
          !alreadyActive &&
          Date.now() - lastOfferSentAtRef.current > 2500
        ) {
          isHandshakingRef.current = false;
          void startWebRTC();
        }
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
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(
              new RTCSessionDescription(sdpPayload)
            );
            isRemoteDescReadyRef.current = true;
            setPeerStatus('CONNECTED');
            setStatus('TERHUBUNG KE MASTER');

            const queue = pendingCandidatesRef.current;
            while (queue.length > 0) {
              const cand = queue.shift();
              if (cand && cand.candidate) {
                await pc
                  .addIceCandidate(new RTCIceCandidate(cand))
                  .catch(() => {});
              }
            }
            transmitTelemetryPacket();
          }
        } catch (err) {
          console.error('[CLIENT] Gagal setRemoteDescription(answer):', err);
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
          } else {
            pendingCandidatesRef.current.push(candidatePayload);
          }
        } catch {}
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

  // Siklus Utama Koneksi Otomatis ke Master (Non-Blocking & Anti-Gagal)
  useEffect(() => {
    let isMounted = true;
    let wsReconnectTimer: number | null = null;
    let autoOfferInterval: number | null = null;
    let httpPollInterval: number | null = null;

    const connectSignalingWebSocket = () => {
      if (!isMounted || isManualDisconnectedRef.current) return;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        return;
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.CLOSING) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }

      try {
        const ws = new WebSocket(getSignalingWebSocketUrl());
        wsRef.current = ws;

        ws.onopen = async () => {
          if (!isMounted || isManualDisconnectedRef.current) return;
          setPeerStatus('CONNECTED');
          setStatus('TERHUBUNG KE MASTER');

          ws.send(
            JSON.stringify({
              type: 'register',
              id: clientId,
              senderId: clientId,
              targetId: 'MASTER',
            })
          );
          transmitTelemetryPacket();

          let pc = pcRef.current;
          if (!pc || pc.signalingState === 'closed') {
            pc = createClientPeerConnection(rawStreamRef.current);
          }
          await sendOfferOverSignaling(pc);
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
          wsReconnectTimer = window.setTimeout(connectSignalingWebSocket, 2500);
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {}
        };
      } catch {
        if (!isManualDisconnectedRef.current) {
          wsReconnectTimer = window.setTimeout(connectSignalingWebSocket, 3000);
        }
      }
    };

    connectWsFnRef.current = connectSignalingWebSocket;

    const bootstrapClientConnection = async () => {
      if (isManualDisconnectedRef.current) return;

      // 1. Langsung daftarkan Klien via HTTP + WebSocket tanpa menunggu izin mikrofon selesai
      void postHttpSignal({
        type: 'register',
        id: clientId,
        senderId: clientId,
        targetId: 'MASTER',
      });
      connectSignalingWebSocket();
      transmitTelemetryPacket();

      // 2. Akuisisi mikrofon + GainNode 300% dengan batas waktu aman (tidak pernah hang)
      const stream = await ensureMicrophoneStream();
      if (!isMounted || isManualDisconnectedRef.current) return;

      // 3. Buat RTCPeerConnection dan kirim SDP Offer ke Master
      const pc = createClientPeerConnection(stream);
      await sendOfferOverSignaling(pc);

      // 4. Polling HTTP /api/signal/:clientId setiap 2 detik
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
      }, 2000);

      // 5. Interval 5 detik untuk pengiriman telemetri & re-offer bila track audio belum tersambung
      autoOfferInterval = window.setInterval(async () => {
        if (!isMounted || isManualDisconnectedRef.current) return;
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          connectSignalingWebSocket();
        }
        transmitTelemetryPacket();

        const pcCurrent = pcRef.current;
        const hasAudioTrack = Boolean(
          pcCurrent &&
            pcCurrent
              .getSenders()
              .some(
                (s) =>
                  s.track &&
                  s.track.kind === 'audio' &&
                  s.track.readyState === 'live'
              )
        );
        const isPcConnected = Boolean(
          pcCurrent &&
            hasAudioTrack &&
            (pcCurrent.connectionState === 'connected' ||
              pcCurrent.iceConnectionState === 'connected' ||
              pcCurrent.iceConnectionState === 'completed')
        );

        if (!isPcConnected) {
          await startWebRTC();
        }
      }, 5000);
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
              lastOfferSentAtRef.current = 0;
              void startWebRTC();
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
    createClientPeerConnection,
    ensureMicrophoneStream,
    postHttpSignal,
    processIncomingSignalingMessage,
    sendOfferOverSignaling,
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
    } else if (wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'register',
          id: clientId,
          senderId: clientId,
          targetId: 'MASTER',
        })
      );
    }

    void postHttpSignal({
      type: 'register',
      id: clientId,
      senderId: clientId,
      targetId: 'MASTER',
    });
    transmitTelemetryPacket();

    const stream = await ensureMicrophoneStream();
    if (isManualDisconnectedRef.current) return;

    const pc = createClientPeerConnection(stream);
    await sendOfferOverSignaling(pc);
  }, [
    clientId,
    createClientPeerConnection,
    ensureMicrophoneStream,
    postHttpSignal,
    requestWakeLock,
    sendOfferOverSignaling,
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
