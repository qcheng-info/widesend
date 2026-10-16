import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomSettings } from '../../shared/room';
import { browserEnvironment } from './browser';
import { Room, type RoomSnapshot } from './room';
import type { RoomEnvironment } from './environment';

// Owns at most one Room for the page and mirrors its snapshot into React state.
export function useRoom() {
  const environment = useRef<RoomEnvironment | undefined>(undefined);
  const current = useRef<{ room: Room; unsubscribe: () => void } | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const env = () => (environment.current ??= browserEnvironment());
  const attach = useCallback(async (room: Room) => {
    current.current?.unsubscribe();
    await current.current?.room.dispose();
    current.current = { room, unsubscribe: room.subscribe(setSnapshot) };
    setSnapshot(room.snapshot);
    await room.start();
  }, []);
  const close = useCallback(async () => {
    const active = current.current;
    current.current = undefined;
    active?.unsubscribe();
    setSnapshot(undefined);
    await active?.room.dispose();
  }, []);
  useEffect(() => () => void current.current?.room.dispose(), []);
  return {
    snapshot,
    room: () => current.current?.room,
    create: (name: string, settings: RoomSettings) =>
      attach(Room.create(env(), { name, settings })),
    join: (code: string, name: string) => attach(Room.join(env(), { code, name })),
    environment: env,
    // The most recent room, or the one at `locator`.
    async restore(locator?: string): Promise<boolean> {
      const room = await Room.restore(env(), locator).catch(() => undefined);
      if (!room) return false;
      await attach(room);
      return true;
    },
    close,
  };
}
