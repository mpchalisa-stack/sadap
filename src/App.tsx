/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Radio,
  Shield,
  Activity,
  Navigation,
  Lock,
  Disc,
  Mic,
  Terminal,
  QrCode,
  Smartphone,
  ScanLine,
} from 'lucide-react';
import { Master } from './Master';
import { Client } from './Client';
import { PWAInstallButton, OfflineIndicator } from './PWAInstallButton';
import { BarcodeModal } from './BarcodeModal';
import { initUniversalRoleAssignment } from './dynamicRoleAssignment';

type AppRole = 'LANDING' | 'MASTER' | 'NODE';

export default function App() {
  const [role, setRole] = useState<AppRole>(() => {
    const params = new URLSearchParams(window.location.search);
    const m = params.get('mode')?.toUpperCase();
    if (m === 'MASTER') return 'MASTER';
    if (m === 'NODE' || m === 'CLIENT') return 'NODE';
    return 'LANDING';
  });

  const [manualOverride, setManualOverride] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get('mode'));
  });

  const [pairedNodeId, setPairedNodeId] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    return id && /^\d{4}$/.test(id) ? id : undefined;
  });

  const [pairedMasterId, setPairedMasterId] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('master') || undefined;
  });

  const [barcodeModalOpen, setBarcodeModalOpen] = useState<boolean>(false);
  const [barcodeModalTab, setBarcodeModalTab] = useState<
    'CLIENT_JOIN' | 'SHARE_APK' | 'SCANNER'
  >('CLIENT_JOIN');

  const [clock, setClock] = useState<string>('18:21:54:00');

  // Dynamic Role Assignment: Saat aplikasi dimuat di halaman awal, kirim { type: "REQUEST_ROLE" } ke WebSocket
  useEffect(() => {
    if (manualOverride || role !== 'LANDING') return;

    let roleClient: ReturnType<typeof initUniversalRoleAssignment> | null = null;

    const initMasterMode = () => {
      roleClient?.disconnect();
      setRole('MASTER');
    };

    const initClientMode = (info: { peerId: string; masterId: string | null }) => {
      roleClient?.disconnect();
      if (info.peerId) {
        setPairedNodeId(info.peerId);
      }
      setRole('NODE');
    };

    roleClient = initUniversalRoleAssignment({
      initMasterMode,
      initClientMode,
    });

    return () => {
      roleClient?.disconnect();
    };
  }, [manualOverride, role]);

  useEffect(() => {
    let raf: number;
    const updateClock = () => {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0');
      setClock(`${hh}:${mm}:${ss}:${ms}`);
      raf = requestAnimationFrame(updateClock);
    };
    raf = requestAnimationFrame(updateClock);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (role === 'MASTER') {
    return (
      <>
        <OfflineIndicator />
        <Master
          onExit={() => {
            setManualOverride(true);
            setRole('LANDING');
          }}
        />
      </>
    );
  }

  if (role === 'NODE') {
    return (
      <>
        <OfflineIndicator />
        <Client
          onExit={() => {
            setManualOverride(true);
            setRole('LANDING');
          }}
          initialNodeId={pairedNodeId}
          initialMasterPeerId={pairedMasterId}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#031525] tactical-grid-bg text-[#dff8ff] flex flex-col justify-between select-none">
      <OfflineIndicator />

      <BarcodeModal
        isOpen={barcodeModalOpen}
        onClose={() => setBarcodeModalOpen(false)}
        initialTab={barcodeModalTab}
        defaultNodeId={pairedNodeId}
        masterPeerId={pairedMasterId}
        onScanNodeId={(scannedId, scannedMasterId) => {
          setPairedNodeId(scannedId);
          if (scannedMasterId) setPairedMasterId(scannedMasterId);
          setRole('NODE');
        }}
      />

      {/* Top Navigation */}
      <header className="border-b border-[#19d3ff]/30 bg-[#041d34]/95 px-4 sm:px-8 py-3.5 flex items-center justify-between gap-8">
        <div className="flex items-center gap-2.5 shrink-0">
          <img
            src="/assets/aistudio/images__10__b9efa126.jpeg"
            alt="Logo TNI AU"
            referrerPolicy="no-referrer"
            className="w-6 h-6 sm:w-7 sm:h-7 object-contain rounded-full border border-[#19d3ff]/40 bg-black p-0.5 shrink-0"
          />
          <div className="font-display-tactical text-lg sm:text-xl font-bold tracking-wider text-[#66ecff] whitespace-nowrap">
            S.I.G.M.A DISKOMLEKAU
          </div>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-xs text-slate-300">
          <button
            onClick={() => setRole('MASTER')}
            className="hover:text-[#66ecff] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Master Monitor
          </button>
          <button
            onClick={() => setRole('NODE')}
            className="hover:text-[#66ecff] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Client Transmitter
          </button>
          <button
            onClick={() => {
              setBarcodeModalTab('CLIENT_JOIN');
              setBarcodeModalOpen(true);
            }}
            className="hover:text-[#66ecff] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Join Barcode
          </button>
          <button
            onClick={() => {
              setBarcodeModalTab('SHARE_APK');
              setBarcodeModalOpen(true);
            }}
            className="hover:text-emerald-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Share APK
          </button>
          <span className="font-mono-tactical text-[#66ecff] font-semibold whitespace-nowrap shrink-0 tabular-nums">
            {clock}
          </span>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <PWAInstallButton />
          <img
            src="/assets/aistudio/1794622160588-picsay_109de27f.png"
            alt="Logo Diskomlekau"
            referrerPolicy="no-referrer"
            className="w-6 h-6 sm:w-7 sm:h-7 object-contain rounded-full border border-[#19d3ff]/40 bg-[#041d34] p-0.5 shrink-0"
          />
        </div>
      </header>

      {/* Main Role Selection Stage */}
      <main className="my-auto max-w-5xl w-full mx-auto px-4 sm:px-8 py-8 space-y-6">
        <div className="border border-[#19d3ff]/35 bg-[#041d34]/90 rounded-lg p-6 sm:p-8 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#66ecff] border-b border-[#19d3ff]/20 pb-3 font-mono-tactical">
            <span>S.I.G.M.A DISKOMLEKAU · WEBRTC AUDIO &amp; GPS TELEMETRY</span>
            <span>STUN: GOOGLE · GAIN: 300% (3.0x) · MAX NODES: 05</span>
          </div>

          <div className="space-y-2">
            <h1 className="font-display-tactical text-3xl sm:text-5xl font-bold tracking-wider text-[#66ecff]">
              S.I.G.M.A DISKOMLEKAU
            </h1>
            <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
              Sistem transmisi suara sensitivitas tinggi satu arah (Client ke Master) dan
              pelacakan posisi koordinat GPS real-time berbasis WebRTC DataChannel.
            </p>
          </div>

          <div className="pt-2 flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => {
                setBarcodeModalTab('CLIENT_JOIN');
                setBarcodeModalOpen(true);
              }}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-[#19d3ff]/20 border border-[#19d3ff] text-[#dff8ff] rounded hover:bg-[#19d3ff]/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <QrCode className="w-4 h-4 text-[#66ecff]" />
              <span>JOIN CLIENT VIA BARCODE</span>
            </button>

            <button
              onClick={() => {
                setBarcodeModalTab('SHARE_APK');
                setBarcodeModalOpen(true);
              }}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-emerald-500/20 border border-emerald-400 text-emerald-200 rounded hover:bg-emerald-500/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Smartphone className="w-4 h-4 text-emerald-400" />
              <span>SHARE APK VIA BARCODE</span>
            </button>

            <button
              onClick={() => {
                setBarcodeModalTab('SCANNER');
                setBarcodeModalOpen(true);
              }}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-amber-500/20 border border-amber-400 text-amber-200 rounded hover:bg-amber-500/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <ScanLine className="w-4 h-4 text-amber-400" />
              <span>SCAN BARCODE KAMERA</span>
            </button>
          </div>
        </div>

        {/* Dual Role Selector Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: MASTER MODE */}
          <div className="border border-[#19d3ff]/45 bg-[#041d34]/95 rounded-lg p-6 flex flex-col justify-between space-y-6 hover:border-[#66ecff] transition-colors">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold tracking-widest text-[#66ecff] font-mono-tactical">
                  01. COMMAND MONITOR
                </span>
                <Activity className="w-5 h-5 text-[#66ecff]" />
              </div>

              <h2 className="font-display-tactical text-2xl font-bold tracking-wide text-white">
                MASTER MONITOR DASHBOARD
              </h2>

              <p className="text-xs text-slate-300 leading-relaxed">
                Stasiun penerima utama untuk memantau hingga 5 unit HP Client secara bersamaan
                dengan visualisasi spektrum audio real-time, perekaman VOX otomatis, dan peta
                lokasi GPS Leaflet.
              </p>

              <div className="space-y-2 pt-2 border-t border-[#19d3ff]/20 text-xs text-slate-300">
                <div className="flex items-center gap-2">
                  <Disc className="w-3.5 h-3.5 text-[#66ecff] shrink-0" />
                  <span>Penerima Audio Multi-Node &amp; Perekaman VOX Otomatis</span>
                </div>
                <div className="flex items-center gap-2">
                  <Navigation className="w-3.5 h-3.5 text-[#66ecff] shrink-0" />
                  <span>Pemetaan Posisi GPS Klien Real-Time (Radius 20 KM)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-[#66ecff] shrink-0" />
                  <span>Kontrol Gain Jarak Jauh &amp; Isolasi Kanal Suara (Solo)</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => setRole('MASTER')}
              className="w-full py-3.5 px-5 bg-[#19d3ff]/20 hover:bg-[#19d3ff]/35 border border-[#19d3ff] text-[#dff8ff] font-bold text-sm tracking-widest rounded transition-all cursor-pointer whitespace-nowrap shrink-0"
            >
              BUKA MASTER MONITOR
            </button>
          </div>

          {/* Card 2: CLIENT TRANSMITTER MODE */}
          <div className="border border-emerald-500/40 bg-[#041d34]/95 rounded-lg p-6 flex flex-col justify-between space-y-6 hover:border-emerald-400 transition-colors">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold tracking-widest text-emerald-400 font-mono-tactical">
                  02. FIELD TRANSMITTER
                </span>
                <Radio className="w-5 h-5 text-emerald-400" />
              </div>

              <h2 className="font-display-tactical text-2xl font-bold tracking-wide text-white">
                CLIENT TRANSMITTER (AUDIO &amp; GPS)
              </h2>

              <p className="text-xs text-slate-300 leading-relaxed">
                Unit pemancar HP Client satu arah (sendonly) dengan penguat sinyal mikrofon
                GainNode 300% (3.0x) tanpa filter peredam bising dan pengiriman koordinat GPS
                presisi tinggi secara langsung ke Master.
              </p>

              <div className="space-y-2 pt-2 border-t border-[#19d3ff]/20 text-xs text-slate-300">
                <div className="flex items-center gap-2">
                  <Mic className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Transmit Suara Sensitivitas Tinggi (GainNode 3.0x / 300%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Audio Raw Tanpa Kompresi (EC: Off, NS: Off, AGC: Off)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Transmit Posisi GPS Real-Time via DataChannel ke Master</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => setRole('NODE')}
              className="w-full py-3.5 px-5 bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400 text-emerald-200 font-bold text-sm tracking-widest rounded transition-all cursor-pointer whitespace-nowrap shrink-0"
            >
              BUKA CLIENT TRANSMITTER
            </button>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#19d3ff]/20 bg-[#020e1a] px-4 sm:px-8 py-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>S.I.G.M.A DISKOMLEKAU · WEBRTC P2P AUDIO &amp; GPS TELEMETRY</span>
        <span>BARCODE PAIRING &amp; STANDALONE PWA</span>
      </footer>
    </div>
  );
}
