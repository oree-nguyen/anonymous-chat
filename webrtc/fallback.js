export class FallbackController extends EventTarget {
  constructor({ sendRatchet, receiveRatchet, persist = () => {} }) {
    super();
    this.mode = 'manual';
    this.sendRatchet = sendRatchet;
    this.receiveRatchet = receiveRatchet;
    this.persist = persist;
    this.transport = null;
    this.intentionalClose = false;
  }

  attach(transport) {
    this.transport = transport;
    transport.addEventListener('open', () => this.setMode('p2p'));
    transport.addEventListener('close', (event) => {
      if (!event.detail?.intentional && !this.intentionalClose) this.setMode('manual');
    });
    transport.addEventListener('connectionstate', (event) => {
      if (['failed', 'disconnected', 'closed'].includes(event.detail) && !this.intentionalClose) this.setMode('manual');
    });
  }

  setMode(mode) {
    if (!['p2p', 'manual', 'connecting'].includes(mode)) throw new Error('Invalid transport mode.');
    if (this.mode === mode) return;
    this.mode = mode;
    this.persist({
      mode,
      sendRatchet: this.sendRatchet?.serialize(),
      receiveRatchet: this.receiveRatchet?.serialize(),
    });
    this.dispatchEvent(new CustomEvent('modechange', { detail: mode }));
  }

  snapshot() {
    return {
      mode: this.mode,
      sendPosition: this.sendRatchet?.position ?? 0,
      receivePosition: this.receiveRatchet?.position ?? 0,
    };
  }

  close() {
    this.intentionalClose = true;
    this.transport?.close();
  }
}
