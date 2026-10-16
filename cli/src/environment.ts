// The web app's transfer engine runs here unchanged. It expects a few browser
// globals; these are their Node stand-ins (see test/unit/globals.test.ts).
export type Direct = { available: true } | { available: false; reason: string };

const sockets = new Set<WebSocket>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
class Unavailable {
  constructor() {
    // transfer.ts treats a failing constructor as "direct unavailable" and uses the relay.
    throw new Error('Direct connections are unavailable.');
  }
}

export async function installEnvironment(server: URL, relayOnly: boolean): Promise<Direct> {
  const origin = server.origin;
  define('location', new URL(origin));
  define('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  define('window', new EventTarget());
  const NodeWebSocket = globalThis.WebSocket;
  class OriginWebSocket extends NodeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      // Browsers send Origin by themselves, and the Worker refuses upgrades without it.
      super(url, { protocols, headers: { Origin: origin } } as unknown as string[]);
      sockets.add(this);
      this.addEventListener('close', () => sockets.delete(this));
    }
  }
  define('WebSocket', OriginWebSocket);
  let direct: Direct = { available: false, reason: 'turned off with --relay' };
  let Peer: unknown = Unavailable;
  if (!relayOnly) {
    try {
      const polyfill = await import('node-datachannel/polyfill');
      browserCandidates(polyfill.RTCIceCandidate.prototype);
      Peer = polyfill.RTCPeerConnection;
      direct = { available: true };
    } catch (error) {
      direct = { available: false, reason: (error as Error).message };
    }
  }
  define('RTCPeerConnection', Peer);
  return direct;
}

// libdatachannel writes candidates as SDP lines ("a=candidate:…"); browsers send
// and expect "candidate:…".
function browserCandidates(prototype: object) {
  const plain = (text: unknown) => (typeof text === 'string' ? text.replace(/^a=/, '') : text);
  const getter = Object.getOwnPropertyDescriptor(prototype, 'candidate')?.get;
  if (getter)
    Object.defineProperty(prototype, 'candidate', {
      configurable: true,
      get() {
        return plain(getter.call(this));
      },
    });
  const target = prototype as { toJSON: () => RTCIceCandidateInit };
  const toJSON = target.toJSON;
  target.toJSON = function () {
    const json = toJSON.call(this);
    return { ...json, candidate: plain(json.candidate) as string };
  };
}

/** Waits for queued frames, such as the final acknowledgement, to leave. */
export async function settleSockets(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (
    [...sockets].some((s) => s.readyState === WebSocket.OPEN && s.bufferedAmount > 0) &&
    Date.now() < deadline
  )
    await sleep(25);
}
export async function socketsClosed(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (sockets.size && Date.now() < deadline) await sleep(25);
}
