import { Destination } from '../storage';
import { IndexedHistoryStore } from './history-store';
import type { RoomEnvironment, SocketLike } from './environment';
import { IndexedMembershipStore } from './membership-store';
import { siteName } from '../site';

// The real browser: OPFS destinations, IndexedDB memberships and history, WebRTC, Web Locks.
// The screen wake lock ends whenever the page is hidden, so ask again on return.
function screenKeeper() {
  let wanted = false,
    sentinel: WakeLockSentinel | undefined;
  const acquire = async () => {
    if (!wanted || document.visibilityState !== 'visible' || (sentinel && !sentinel.released))
      return;
    try {
      sentinel = await navigator.wakeLock?.request('screen');
    } catch {
      /* Browsers may decline in background or low-power mode. */
    }
  };
  document.addEventListener('visibilitychange', () => void acquire());
  return (on: boolean) => {
    wanted = on;
    if (on) void acquire();
    else {
      void sentinel?.release().catch(() => {});
      sentinel = undefined;
    }
  };
}

export function browserEnvironment(): RoomEnvironment {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return {
    keepAwake: screenKeeper(),
    // The deployment's site name, so rooms pair across its addresses.
    get origin() {
      return siteName();
    },
    socketUrl: (locator) =>
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/share/${locator}`,
    connect: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
    store: new IndexedMembershipStore(),
    history: new IndexedHistoryStore(),
    async sink(files, folder) {
      const destination = new Destination();
      try {
        await destination.prepare(files, undefined, folder);
      } catch (error) {
        await destination.dispose().catch(() => {});
        throw error;
      }
      return {
        open: (meta) => destination.open(meta),
        write: (offset, data) => destination.write(offset, data),
        async finish(_meta, sha256) {
          await destination.flush();
          return destination.finish(sha256);
        },
        dispose: () => destination.dispose(),
      };
    },
    rtc: typeof RTCPeerConnection === 'undefined' ? undefined : RTCPeerConnection,
    lock: locks
      ? (name) =>
          new Promise((resolve) => {
            void locks
              .request(name, { ifAvailable: true }, (lock) => {
                if (!lock) {
                  resolve(undefined);
                  return;
                }
                return new Promise<void>((release) => resolve(release));
              })
              .catch(() => resolve(undefined));
          })
      : undefined,
  };
}

// A sensible default display name for this device (members can change it).
export function deviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1))
    return 'iPad';
  if (/Android/.test(agent)) return 'Android';
  if (/Macintosh|Mac OS X/.test(agent)) return 'Mac';
  if (/Windows/.test(agent)) return 'Windows PC';
  if (/CrOS/.test(agent)) return 'Chromebook';
  if (/Linux/.test(agent)) return 'Linux PC';
  return 'Browser';
}
