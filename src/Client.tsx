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
    return 'SENSOR-' + Math.floor(1000 + Math.random() * 9000);
  });

  const [status, setStatus] = useState<string>('INISIALISASI...');
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [isConnectedToMaster, setIsConnectedToMaster] = useState<boolean>(false);
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
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const isManualStoppedRef = useRef<boolean>(false);

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

  // Perbarui nilai GainNode secara real-time saat slider sensitivitas diubah
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = isMuted ? 0 : sensitivityGain;
    }
    if (rawStreamRef.current) {
      rawStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });
    }
  }, [sensitivityGain, isMuted]);

  // Baca informasi baterai perangkat jika tersedia
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

  // Fungsi kirim sinyal ke HTTP fallback (/api/signal) agar tetap tembus di jaringan seluler ketat
  const postHttpSignal = useCallback(async (packet: Record<string, unknown>) => {
    if (isManualStoppedRef.current) return;
    try {
      const res = await fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet),
      });
      if (res.ok && !isManualStoppedRef.current) {
        setIsConnectedToMaster(true);
      }
    } catch {}
  }, []);

  // Kirim paket koordinat GPS ke Master via DataChannel ('tactical-telemetry'), WebSocket, dan HTTP Fallback
  const sendGpsPayloadToMaster = useCallback(
    (
      coords: {
        lat: number | null;
        lng: number | null;
        alt: number | null;
        accuracy: number | null;
        speed: number | null;
      },
      customChannel?: RTCDataChannel | null
    ) => {
      if (isManualStoppedRef.current) return;

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

      const activeDc = customChannel || dcRef.current;
      if (activeDc && activeDc.readyState === 'open') {
        try {
          activeDc.send(JSON.stringify(gpsUpdatePacket));
          activeDc.send(JSON.stringify(sigmaTelemetryPacket));
        } catch {}
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(
            JSON.stringify({
              ...sigmaTelemetryPacket,
              senderId: clientId,
              targetId: 'MASTER',
            })
          );
        } catch {}
      }

      void postHttpSignal({
        ...sigmaTelemetryPacket,
        senderId: clientId,
        targetId: 'MASTER',
      });
    },
    [clientId, postHttpSignal]
  );

  // Fungsi Transmit GPS Real-time
  const startGpsTracking = useCallback(
    (dataChannel?: RTCDataChannel | null) => {
      if (!navigator.geolocation) return;

      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const nextCoords = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            alt:
              position.coords.altitude !== null
                ? Math.round(position.coords.altitude)
                : null,
            accuracy: Math.max(1, Math.round(position.coords.accuracy)),
            speed:
              position.coords.speed !== null
                ? Math.round(position.coords.speed * 3.6)
                : null,
            lastUpdated: Date.now(),
          };
          setGpsCoords(nextCoords);
          sendGpsPayloadToMaster(nextCoords, dataChannel);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
      );

      watchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          const nextCoords = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            alt:
              position.coords.altitude !== null
                ? Math.round(position.coords.altitude)
                : null,
            accuracy: Math.max(1, Math.round(position.coords.accuracy)),
            speed:
              position.coords.speed !== null
                ? Math.round(position.coords.speed * 3.6)
                : null,
            lastUpdated: Date.now(),
          };
          setGpsCoords(nextCoords);
          sendGpsPayloadToMaster(nextCoords, dataChannel);
        },
        (err) => console.warn('[GPS]', err.message),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
      );
    },
    [sendGpsPayloadToMaster]
  );

  // Tangani sinyal masuk dari Master (Answer, Candidate, atau Kontrol Gain/Mute)
  const handleSignalingMessage = useCallback(
    async (msg: SignalingMessage) => {
      if (!msg || !msg.type || isManualStoppedRef.current) return;
      if (msg.targetId && msg.targetId !== clientId) return;

      if (msg.type === 'master_ack' || msg.type === 'master_online') {
        setIsConnectedToMaster(true);
        setStatus('TERHUBUNG KE MASTER');
        return;
      }

      const pc = pcRef.current;
      if (!pc) return;

      const sdpPayload = (msg.sdp || msg.data) as
        | RTCSessionDescriptionInit
        | undefined;
      if (
        (msg.type === 'answer' || msg.type === 'ANSWER') &&
        sdpPayload &&
        sdpPayload.sdp
      ) {
        try {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(
              new RTCSessionDescription(sdpPayload)
            );
            setIsConnectedToMaster(true);
            setStatus('TERHUBUNG KE MASTER');

            while (pendingCandidatesRef.current.length > 0) {
              const cand = pendingCandidatesRef.current.shift();
              if (cand && cand.candidate) {
                await pc
                  .addIceCandidate(new RTCIceCandidate(cand))
                  .catch(() => {});
              }
            }
          }
        } catch (err) {
          console.error('[CLIENT] Gagal setRemoteDescription:', err);
        }
        return;
      }

      const candidatePayload = (msg.candidate || msg.data) as
        | RTCIceCandidateInit
        | undefined;
      if (
        (msg.type === 'candidate' || msg.type === 'ICE_CANDIDATE') &&
        candidatePayload &&
        candidatePayload.candidate
      ) {
        try {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidatePayload));
          } else {
            pendingCandidatesRef.current.push(candidatePayload);
          }
        } catch {}
        return;
      }

      if (msg.type === 'SET_GAIN' && typeof msg.value === 'number') {
        setSensitivityGain(msg.value);
      } else if (msg.type === 'SET_MUTE') {
        setIsMuted(Boolean(msg.value));
      }
    },
    [clientId]
  );

  // Fungsi Utama Transmisi Suara Sensitivitas Tinggi & GPS ke Master
  const initiateTransmission = useCallback(async () => {
    try {
      isManualStoppedRef.current = false;
      setIsTransmitting(true);
      setStatus('MENGAKSES PERANGKAT...');

      // 1. WAKE LOCK (Menjaga koneksi tetap aktif saat layar menyala)
      if ('wakeLock' in navigator && navigator.wakeLock) {
        navigator.wakeLock
          .request('screen')
          .then((sentinel) => {
            wakeLockRef.current = sentinel;
          })
          .catch(() => {});
      }

      // 2. SETUP AUDIO SENSITIVITAS TINGGI
      let rawStream: MediaStream | null = null;
      try {
        rawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
      } catch {
        // Fallback ke constraint audio standar bila browser seluler menolak constraint mentah
        rawStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      }

      rawStreamRef.current = rawStream;

      // Penguat Sinyal Digital (GainNode) - Sensitivitas Default 300% (3.0)
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume().catch(() => {});
      }

      const source = audioCtx.createMediaStreamSource(rawStream);
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = mutedRef.current ? 0 : gainValueRef.current;
      gainNodeRef.current = gainNode;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;

      const destination = audioCtx.createMediaStreamDestination();

      source.connect(gainNode);
      gainNode.connect(analyser);
      gainNode.connect(destination);

      const amplifiedStream = destination.stream;

      // Meter level sinyal audio real-time
      const timeData = new Uint8Array(analyser.frequencyBinCount);
      const updateAudioMeter = () => {
        if (
          isManualStoppedRef.current ||
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
        requestAnimationFrame(updateAudioMeter);
      };
      requestAnimationFrame(updateAudioMeter);

      // 3. SETUP WEBRTC
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {}
      }

      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;
      pendingCandidatesRef.current = [];

      // Masukkan stream yang sudah diperkuat ke WebRTC dengan arah sendonly
      const tracksToSend =
        amplifiedStream.getAudioTracks().length > 0
          ? amplifiedStream.getAudioTracks()
          : rawStream.getAudioTracks();

      tracksToSend.forEach((track) => {
        pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [amplifiedStream],
        });
      });

      // 4. SETUP DATA CHANNEL UNTUK GPS ('tactical-telemetry')
      const dc = pc.createDataChannel('tactical-telemetry', {
        ordered: true,
      });
      dcRef.current = dc;

      dc.onopen = () => {
        setIsConnectedToMaster(true);
        setStatus('TERHUBUNG KE MASTER');
        startGpsTracking(dc);
      };

      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as SignalingMessage;
          void handleSignalingMessage(msg);
        } catch {}
      };

      // Mulai lacak GPS segera agar koordinat siap dikirim ke Master
      startGpsTracking(dc);

      pc.onicecandidate = (event) => {
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
          }
          void postHttpSignal(candidatePacket);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        if (st === 'connected' || st === 'completed') {
          setIsConnectedToMaster(true);
          setStatus('TERHUBUNG KE MASTER');
        }
      };

      // 5. SETUP SIGNALING (WEBSOCKET + HTTP FALLBACK)
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }

      const ws = new WebSocket(getSignalingWebSocketUrl());
      wsRef.current = ws;

      const sendInitialOffer = async () => {
        if (isManualStoppedRef.current || pc.signalingState === 'closed') return;
        setStatus('NEGOSIASI KONEKSI...');

        const regPacket = {
          type: 'register',
          id: clientId,
          senderId: clientId,
          targetId: 'MASTER',
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(regPacket));
        }
        await postHttpSignal(regPacket);

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
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(offerPacket));
          }
          await postHttpSignal(offerPacket);
        }
      };

      ws.onopen = () => {
        void sendInitialOffer();
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data) as SignalingMessage;
          await handleSignalingMessage(msg);
        } catch {}
      };

      ws.onerror = () => {
        // Jika WebSocket lambat/terhambat, tetap kirim Offer via HTTP signaling
        void sendInitialOffer();
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      setStatus('MENUNGGU IZIN MIKROFON / KLIK MULAI TRANSMISI (' + errMsg + ')');
      setIsTransmitting(false);
    }
  }, [clientId, handleSignalingMessage, postHttpSignal, startGpsTracking]);

  const stopTransmission = useCallback(() => {
    isManualStoppedRef.current = true;
    setIsTransmitting(false);
    setIsConnectedToMaster(false);
    setAudioRms(0);
    setStatus('TRANSMISI DIHENTIKAN (STANDBY)');

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

    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {}
      dcRef.current = null;
    }

    if (pcRef.current) {
      try {
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

    if (rawStreamRef.current) {
      rawStreamRef.current.getTracks().forEach((t) => t.stop());
      rawStreamRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, [clientId]);

  // Otomatis jalankan saat komponen Client dibuka + polling jawaban Master setiap 2 detik
  useEffect(() => {
    void initiateTransmission();

    const pollInterval = window.setInterval(async () => {
      if (isManualStoppedRef.current) return;
      try {
        const res = await fetch(`/api/signal/${encodeURIComponent(clientId)}`);
        if (!res.ok) return;
        const payload = (await res.json()) as {
          ok?: boolean;
          messages?: SignalingMessage[];
        };
        if (Array.isArray(payload.messages)) {
          for (const msg of payload.messages) {
            await handleSignalingMessage(msg);
          }
        }
      } catch {}
    }, 2000);

    const telemetryHeartbeat = window.setInterval(() => {
      if (isManualStoppedRef.current) return;
      sendGpsPayloadToMaster(gpsRef.current);
    }, 5000);

    return () => {
      clearInterval(pollInterval);
      clearInterval(telemetryHeartbeat);
      stopTransmission();
    };
  }, [
    clientId,
    handleSignalingMessage,
    initiateTransmission,
    sendGpsPayloadToMaster,
    stopTransmission,
  ]);

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
            TACTICAL NET-COMM SUBDISRUDAL
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
            alt="Logo Subdisrudal"
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
            <span className="font-mono-tactical text-[#66ecff] font-semibold">
              CLIENT TRANSMITTER NODE
            </span>
            <span
              className={`font-mono-tactical font-bold ${
                isConnectedToMaster
                  ? 'text-emerald-400'
                  : isTransmitting
                  ? 'text-amber-300'
                  : 'text-rose-400'
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
              Target Koneksi: <span className="font-mono-tactical text-[#66ecff]">MASTER</span> · Mode Transmisi: <span className="font-mono-tactical text-emerald-300">SENDONLY AUDIO + GPS</span>
            </div>
          </div>

          {/* Primary Start / Stop Controls */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <button
              type="button"
              onClick={() => void initiateTransmission()}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded font-bold text-xs tracking-wider bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400 text-emerald-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Power className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{isTransmitting ? 'RE-TRANSMIT' : 'MULAI TRANSMISI'}</span>
            </button>

            <button
              type="button"
              onClick={stopTransmission}
              disabled={!isTransmitting}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded font-bold text-xs tracking-wider bg-rose-500/20 hover:bg-rose-500/35 border border-rose-400 text-rose-200 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
            >
              <PowerOff className="w-4 h-4 text-rose-400 shrink-0" />
              <span>HENTIKAN TRANSMISI</span>
            </button>
          </div>
        </section>

        {/* High-Sensitivity Audio Gain Control (Default 300% / 3.0x) */}
        <section className="border border-[#19d3ff]/30 bg-[#041d34]/80 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 font-semibold text-[#66ecff]">
              <Sliders className="w-4 h-4 text-[#19d3ff]" />
              <span>PENGUAT SINYAL AUDIO (GAINNODE)</span>
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
                    {batteryInfo.level !== null ? `${batteryInfo.level}%` : ' Aktif'}
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
          <span>TACTICAL NET-COMM SUBDISRUDAL · ONE-WAY AUDIO &amp; GPS TELEMETRY</span>
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
