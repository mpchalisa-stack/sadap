import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface SignalingPayload {
  type: string;
  id?: string;
  senderId?: string;
  targetId?: string;
  target?: string;
  data?: unknown;
  sdp?: unknown;
  candidate?: unknown;
  role?: string;
  peerId?: string;
  nodeId?: string;
  [key: string]: unknown;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const server = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  // ============================================================================
  // 1. REGISTRASI & ROUTING WEBSOCKET SINKRON (`clients = new Map<string, ws>()`)
  // ============================================================================
  const clients = new Map<string, WebSocket>();
  const masterSockets = new Set<WebSocket>();
  const socketToId = new Map<WebSocket, string>();
  const httpMailboxes = new Map<string, SignalingPayload[]>();
  const knownClientIds = new Set<string>();
  const processedPackets = new Map<string, number>();

  const isDuplicatePacket = (packetId?: unknown): boolean => {
    if (typeof packetId !== 'string' || !packetId) return false;
    const now = Date.now();
    if (processedPackets.has(packetId)) {
      return true;
    }
    processedPackets.set(packetId, now);
    if (processedPackets.size > 1500) {
      for (const [k, ts] of processedPackets.entries()) {
        if (now - ts > 60000) processedPackets.delete(k);
      }
    }
    return false;
  };

  const enqueueMailbox = (targetId: string, packet: SignalingPayload) => {
    let queue = httpMailboxes.get(targetId) || [];
    if (
      packet.packetId &&
      queue.some((item) => item.packetId === packet.packetId)
    ) {
      return;
    }
    // Jangan biarkan paket telemetri atau ack menumpuk dan menggeser paket SDP offer/answer/candidate
    if (
      packet.type === 'SIGMA_TELEMETRY' ||
      packet.type === 'GPS_UPDATE' ||
      packet.type === 'master_ack' ||
      packet.type === 'client_registered'
    ) {
      queue = queue.filter(
        (item) =>
          !(
            item.type === packet.type &&
            (item.senderId || item.nodeId) ===
              (packet.senderId || packet.nodeId)
          )
      );
    }
    queue.push(packet);
    if (queue.length > 200) queue.shift();
    httpMailboxes.set(targetId, queue);
  };

  const wss = new WebSocketServer({ noServer: true });
  const hmrWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      if (protocols.has('vite-hmr')) return 'vite-hmr';
      if (protocols.has('vite-ping')) return 'vite-ping';
      const first = protocols.values().next().value;
      return first || false;
    },
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const protocolHeader = String(
      request.headers['sec-websocket-protocol'] || ''
    );
    const reqUrl = request.url || '/';

    if (
      protocolHeader.includes('vite-hmr') ||
      protocolHeader.includes('vite-ping') ||
      reqUrl.includes('token=') ||
      reqUrl.includes('__vite')
    ) {
      hmrWss.handleUpgrade(request, socket, head, (ws) => {
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'connected' }));
        }
        ws.on('message', (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed?.type === 'ping' && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
          } catch {}
        });
      });
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[SERVER-WS] Koneksi WebSocket baru masuk.');

    ws.on('message', (rawMessage) => {
      let data: SignalingPayload | null = null;
      try {
        data = JSON.parse(rawMessage.toString()) as SignalingPayload;
      } catch (err) {
        console.error('[SERVER-WS] Gagal parse JSON:', err);
        return;
      }

      if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
        return;
      }

      if (isDuplicatePacket(data.packetId)) {
        return;
      }

      // ======================================================================
      // ATURAN 1: REGISTRASI WAJIB (`{ type: "register", id: "MASTER" | myClientId }`)
      // ======================================================================
      if (
        data.type === 'register' ||
        data.type === 'REGISTER' ||
        data.type === 'register_master' ||
        data.type === 'register_client'
      ) {
        const rawId = String(
          data.id ||
            data.senderId ||
            (data.type === 'register_master' ? 'MASTER' : '')
        );
        if (!rawId) {
          return;
        }

        const normalizedId =
          rawId.toUpperCase() === 'MASTER' ? 'MASTER' : rawId;

        clients.set(normalizedId, ws);
        socketToId.set(ws, normalizedId);
        if (normalizedId === 'MASTER') {
          masterSockets.add(ws);
        } else {
          knownClientIds.add(normalizedId);
        }

        console.log(
          `[SERVER-WS] REGISTERED: id="${normalizedId}" | Total Peer Aktif: ${
            clients.size
          } -> [${Array.from(clients.keys()).join(', ')}]`
        );

        // Jika MASTER baru saja register, beri tahu semua Client yang sudah menunggu
        if (normalizedId === 'MASTER') {
          const allTargetClients = new Set<string>([
            ...Array.from(clients.keys()),
            ...Array.from(knownClientIds),
          ]);
          allTargetClients.forEach((clientId) => {
            if (clientId === 'MASTER') return;
            const onlineMsg: SignalingPayload = {
              type: 'master_online',
              senderId: 'MASTER',
              targetId: clientId,
            };
            const clientWs = clients.get(clientId);
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify(onlineMsg));
            }
            enqueueMailbox(clientId, onlineMsg);
          });
        } else {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'master_ack',
                senderId: 'MASTER',
                targetId: normalizedId,
              })
            );
          }

          const regNotify: SignalingPayload = {
            type: 'client_registered',
            senderId: normalizedId,
            targetId: 'MASTER',
          };
          masterSockets.forEach((mWs) => {
            if (mWs.readyState === WebSocket.OPEN) {
              mWs.send(JSON.stringify(regNotify));
            }
          });
          enqueueMailbox('MASTER', regNotify);
        }
        return;
      }

      // Dukungan Dynamic Role Assignment (`REQUEST_ROLE`) tanpa menimpa socket MASTER utama
      if (data.type === 'REQUEST_ROLE') {
        const masterWs = clients.get('MASTER');
        const isMasterOnline =
          masterWs !== undefined && masterWs.readyState === WebSocket.OPEN;
        const peerId = String(
          data.peerId ||
            data.id ||
            data.senderId ||
            `client-${Math.floor(1000 + Math.random() * 9000)}`
        );

        if (!isMasterOnline) {
          ws.send(
            JSON.stringify({
              type: 'ROLE_ASSIGNED',
              role: 'MASTER',
              peerId: 'MASTER',
              masterId: 'MASTER',
            })
          );
        } else {
          ws.send(
            JSON.stringify({
              type: 'ROLE_ASSIGNED',
              role: 'CLIENT',
              peerId,
              masterId: 'MASTER',
            })
          );
        }
        return;
      }

      // Pastikan pengirim otomatis terdaftar di Map jika belum sempat mengirim `register`
      if (data.senderId) {
        const senderKey =
          data.senderId.toUpperCase() === 'MASTER' ? 'MASTER' : data.senderId;
        if (senderKey !== 'MASTER') {
          knownClientIds.add(senderKey);
        }
        if (!clients.has(senderKey)) {
          clients.set(senderKey, ws);
          socketToId.set(ws, senderKey);
          if (senderKey === 'MASTER') {
            masterSockets.add(ws);
          }
        }
      }

      // ======================================================================
      // ATURAN 2: ROUTING YANG SINKRON KE `clients.get(data.targetId)`
      // ======================================================================
      const rawTargetId = String(data.targetId || data.target || '');
      if (!rawTargetId) {
        return;
      }

      const targetId =
        rawTargetId.toUpperCase() === 'MASTER' ? 'MASTER' : rawTargetId;

      const normalizedPacket: SignalingPayload = {
        ...data,
        senderId:
          data.senderId?.toUpperCase() === 'MASTER' ? 'MASTER' : data.senderId,
        targetId,
        sdp:
          data.sdp !== undefined
            ? data.sdp
            : data.type === 'offer' ||
              data.type === 'OFFER' ||
              data.type === 'answer' ||
              data.type === 'ANSWER'
            ? data.data
            : undefined,
        candidate:
          data.candidate !== undefined
            ? data.candidate
            : data.type === 'candidate' || data.type === 'ICE_CANDIDATE'
            ? data.data
            : undefined,
        data:
          data.data !== undefined
            ? data.data
            : data.sdp !== undefined
            ? data.sdp
            : data.candidate !== undefined
            ? data.candidate
            : undefined,
      };

      // Kirim ack instan ke Client saat mengirim offer atau telemetri
      if (
        targetId === 'MASTER' &&
        normalizedPacket.senderId &&
        normalizedPacket.senderId !== 'MASTER' &&
        (data.type === 'offer' ||
          data.type === 'OFFER' ||
          data.type === 'SIGMA_TELEMETRY' ||
          data.type === 'GPS_UPDATE') &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(
          JSON.stringify({
            type: 'master_ack',
            senderId: 'MASTER',
            targetId: normalizedPacket.senderId,
          })
        );
      }

      if (targetId === 'MASTER') {
        let deliveredCount = 0;
        masterSockets.forEach((mWs) => {
          if (mWs.readyState === WebSocket.OPEN) {
            mWs.send(JSON.stringify(normalizedPacket));
            deliveredCount++;
          }
        });
        if (deliveredCount === 0) {
          const fallbackMaster = clients.get('MASTER');
          if (fallbackMaster && fallbackMaster.readyState === WebSocket.OPEN) {
            fallbackMaster.send(JSON.stringify(normalizedPacket));
            deliveredCount++;
          }
        }
        if (data.type !== 'SIGMA_WS_AUDIO') {
          enqueueMailbox('MASTER', normalizedPacket);
        }
      } else {
        const targetWs = clients.get(targetId);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify(normalizedPacket));
        }
        enqueueMailbox(targetId, normalizedPacket);
      }
    });

    ws.on('close', () => {
      masterSockets.delete(ws);
      const closedId = socketToId.get(ws);
      socketToId.delete(ws);

      if (closedId && clients.get(closedId) === ws) {
        if (closedId === 'MASTER' && masterSockets.size > 0) {
          const nextMasterWs = Array.from(masterSockets).find(
            (s) => s.readyState === WebSocket.OPEN
          );
          if (nextMasterWs) {
            clients.set('MASTER', nextMasterWs);
            return;
          }
        }

        clients.delete(closedId);

        if (closedId !== 'MASTER') {
          const disconnectNotify: SignalingPayload = {
            type: 'client_disconnected',
            senderId: closedId,
            targetId: 'MASTER',
          };
          masterSockets.forEach((mWs) => {
            if (mWs.readyState === WebSocket.OPEN) {
              mWs.send(JSON.stringify(disconnectNotify));
            }
          });
          enqueueMailbox('MASTER', disconnectNotify);
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[SERVER-WS] Socket error:', err);
    });
  });

  // Jalur HTTP Signaling Fallback (/api/signal)
  app.post('/api/signal', (req, res) => {
    const data = req.body as SignalingPayload;
    if (!data || typeof data !== 'object') {
      res.status(400).json({ ok: false });
      return;
    }

    if (isDuplicatePacket(data.packetId)) {
      res.json({ ok: true, deduplicated: true, masterOnline: true });
      return;
    }

    if (
      data.type === 'register' ||
      data.type === 'REGISTER' ||
      data.type === 'register_master' ||
      data.type === 'register_client'
    ) {
      const rawId = String(
        data.id ||
          data.senderId ||
          (data.type === 'register_master' ? 'MASTER' : '')
      );
      const normalizedId =
        rawId.toUpperCase() === 'MASTER' ? 'MASTER' : rawId;

      if (normalizedId === 'MASTER') {
        const allTargetClients = new Set<string>([
          ...Array.from(clients.keys()),
          ...Array.from(knownClientIds),
        ]);
        allTargetClients.forEach((clientId) => {
          if (clientId === 'MASTER') return;
          const onlineMsg: SignalingPayload = {
            type: 'master_online',
            senderId: 'MASTER',
            targetId: clientId,
          };
          const clientWs = clients.get(clientId);
          if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify(onlineMsg));
          }
          enqueueMailbox(clientId, onlineMsg);
        });
      } else if (normalizedId) {
        knownClientIds.add(normalizedId);
        const regNotify: SignalingPayload = {
          type: 'client_registered',
          senderId: normalizedId,
          targetId: 'MASTER',
        };
        masterSockets.forEach((mWs) => {
          if (mWs.readyState === WebSocket.OPEN) {
            mWs.send(JSON.stringify(regNotify));
          }
        });
        enqueueMailbox('MASTER', regNotify);
        enqueueMailbox(normalizedId, {
          type: 'master_ack',
          senderId: 'MASTER',
          targetId: normalizedId,
        });
      }
      res.json({ ok: true, masterOnline: true });
      return;
    }

    const rawTarget = String(data.targetId || data.target || 'MASTER');
    const targetId =
      rawTarget.toUpperCase() === 'MASTER' ? 'MASTER' : rawTarget;

    if (data.senderId && data.senderId.toUpperCase() !== 'MASTER') {
      knownClientIds.add(String(data.senderId));
    }

    const normalizedPacket: SignalingPayload = {
      ...data,
      senderId:
        data.senderId?.toUpperCase() === 'MASTER' ? 'MASTER' : data.senderId,
      targetId,
      sdp:
        data.sdp !== undefined
          ? data.sdp
          : data.type === 'offer' ||
            data.type === 'OFFER' ||
            data.type === 'answer' ||
            data.type === 'ANSWER'
          ? data.data
          : undefined,
      candidate:
        data.candidate !== undefined
          ? data.candidate
          : data.type === 'candidate' || data.type === 'ICE_CANDIDATE'
          ? data.data
          : undefined,
      data:
        data.data !== undefined
          ? data.data
          : data.sdp !== undefined
          ? data.sdp
          : data.candidate !== undefined
          ? data.candidate
          : undefined,
    };

    if (targetId === 'MASTER') {
      masterSockets.forEach((mWs) => {
        if (mWs.readyState === WebSocket.OPEN) {
          mWs.send(JSON.stringify(normalizedPacket));
        }
      });
      if (data.type !== 'SIGMA_WS_AUDIO') {
        enqueueMailbox('MASTER', normalizedPacket);
      }
      if (normalizedPacket.senderId && normalizedPacket.senderId !== 'MASTER') {
        enqueueMailbox(String(normalizedPacket.senderId), {
          type: 'master_ack',
          senderId: 'MASTER',
          targetId: String(normalizedPacket.senderId),
        });
      }
    } else {
      const targetWs = clients.get(targetId);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(normalizedPacket));
      }
      enqueueMailbox(targetId, normalizedPacket);
    }

    res.json({ ok: true, masterOnline: true });
  });

  app.get('/api/signal/:targetId', (req, res) => {
    const rawTarget = req.params.targetId;
    const targetId =
      rawTarget.toUpperCase() === 'MASTER' ? 'MASTER' : rawTarget;
    const messages = httpMailboxes.get(targetId) || [];
    httpMailboxes.set(targetId, []);
    res.json({
      ok: true,
      messages,
      masterOnline: true,
    });
  });

  app.get('/api/health', (_req, res) => {
    const activeIds = Array.from(clients.keys());
    res.json({
      status: 'ok',
      masterOnline: clients.has('MASTER'),
      connectedIds: activeIds,
      clientsCount: activeIds.filter((id) => id !== 'MASTER').length,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[SERVER] S.I.G.M.A. Multi-Peer Signaling Server listening on http://0.0.0.0:${PORT}`
    );
  });
}

startServer();
