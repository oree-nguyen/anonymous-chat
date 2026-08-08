import { generateEcdhKeyPair, exportPublicKey, deriveRootKey, safetyNumber } from '../crypto/ecdh.js';
import { encodeHandshake, decodeHandshake } from './handshake.js';

export const STUN_CONFIG = Object.freeze({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});
const HEARTBEAT_PING = '__anonymous_chat_ping__';
const HEARTBEAT_PONG = '__anonymous_chat_pong__';

export function waitForIceComplete(peer, timeoutMs = 30_000) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('ICE gathering timed out. Try manual mode or another network.'));
    }, timeoutMs);
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') {
        cleanup();
        resolve();
      }
    };
    function cleanup() {
      clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', onChange);
    }
    peer.addEventListener('icegatheringstatechange', onChange);
  });
}

export class PeerTransport extends EventTarget {
  constructor(options = {}) {
    super();
    this.peerFactory = options.peerFactory ?? ((configuration) => new RTCPeerConnection(configuration));
    this.keyPair = options.keyPair ?? null;
    this.localPublicKey = options.localPublicKey ?? null;
    this.remotePublicKey = options.remotePublicKey ?? null;
    this.rootKey = options.rootKey ?? null;
    this.peer = null;
    this.channel = null;
    this.closedByUser = false;
    this.iceServers = options.iceServers ?? STUN_CONFIG.iceServers;
    this.heartbeatTimer = null;
    this.lastPongAt = 0;
  }

  async ensureIdentity() {
    if (!this.keyPair) this.keyPair = await generateEcdhKeyPair();
    if (!this.localPublicKey) this.localPublicKey = await exportPublicKey(this.keyPair.publicKey);
  }

  createPeer() {
    this.peer?.close();
    const peer = this.peerFactory({ iceServers: this.iceServers });
    this.peer = peer;
    peer.addEventListener('connectionstatechange', () => {
      this.dispatchEvent(new CustomEvent('connectionstate', { detail: peer.connectionState }));
    });
    return peer;
  }

  bindChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      this.lastPongAt = Date.now();
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (channel.readyState !== 'open') return;
        if (Date.now() - this.lastPongAt > 30_000) this.dispatchEvent(new Event('heartbeattimeout'));
        else channel.send(HEARTBEAT_PING);
      }, 15_000);
      this.dispatchEvent(new Event('open'));
    });
    channel.addEventListener('message', (event) => {
      if (event.data === HEARTBEAT_PING) {
        if (channel.readyState === 'open') channel.send(HEARTBEAT_PONG);
        return;
      }
      if (event.data === HEARTBEAT_PONG) {
        this.lastPongAt = Date.now();
        this.dispatchEvent(new Event('heartbeat'));
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
    });
    channel.addEventListener('error', (event) => this.dispatchEvent(new CustomEvent('channelerror', { detail: event })));
    channel.addEventListener('close', () => {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.dispatchEvent(new CustomEvent('close', { detail: { intentional: this.closedByUser } }));
    });
  }

  async createOffer({ reconnect = false, senderName = '' } = {}) {
    await this.ensureIdentity();
    const peer = this.createPeer();
    this.bindChannel(peer.createDataChannel('anonymous-chat', { ordered: true }));
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceComplete(peer);
    return encodeHandshake({
      kind: reconnect ? 'reconnect-offer' : 'offer',
      sdp: peer.localDescription.sdp,
      publicKey: this.localPublicKey,
      senderName,
    });
  }

  async acceptOffer(code, { reconnect = false, senderName = '' } = {}) {
    const offer = await decodeHandshake(code, reconnect ? 'reconnect-offer' : 'offer');
    await this.ensureIdentity();
    this.remotePublicKey = offer.publicKey;
    const peer = this.createPeer();
    peer.addEventListener('datachannel', (event) => this.bindChannel(event.channel), { once: true });
    await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    await waitForIceComplete(peer);
    if (!reconnect || !this.rootKey) this.rootKey = await deriveRootKey(this.keyPair.privateKey, this.remotePublicKey);
    return encodeHandshake({
      kind: reconnect ? 'reconnect-answer' : 'answer',
      sdp: peer.localDescription.sdp,
      publicKey: this.localPublicKey,
      senderName,
    });
  }

  async acceptAnswer(code, { reconnect = false } = {}) {
    if (!this.peer) throw new Error('Create an offer before accepting an answer.');
    const answer = await decodeHandshake(code, reconnect ? 'reconnect-answer' : 'answer');
    this.remotePublicKey = answer.publicKey;
    await this.peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    if (!reconnect || !this.rootKey) this.rootKey = await deriveRootKey(this.keyPair.privateKey, this.remotePublicKey);
    return this.rootKey;
  }

  async getSafetyNumber() {
    if (!this.localPublicKey || !this.remotePublicKey) throw new Error('Both public keys are required.');
    return safetyNumber(this.localPublicKey, this.remotePublicKey);
  }

  send(bytes) {
    if (!this.channel || this.channel.readyState !== 'open') throw new Error('Direct channel is not open.');
    this.channel.send(bytes);
  }

  close() {
    this.closedByUser = true;
    this.channel?.close();
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.peer?.close();
    this.rootKey?.fill(0);
    this.rootKey = null;
    this.keyPair = null;
    this.localPublicKey = null;
    this.remotePublicKey = null;
    this.channel = null;
    this.peer = null;
  }
}
