import type { Change, GameEvent, PlayerSnapshot, RoomInfo } from './constants.js';

// ------------------------------------------------------------
//  Cliente -> Servidor
// ------------------------------------------------------------
export type C2S =
  | { t: 'hello'; name: string }
  | { t: 'rooms' }
  | { t: 'create'; name: string; opts?: CreateOpts }
  | { t: 'join'; room: string; name: string }
  | { t: 'start' }
  | { t: 'cmd'; c: 'attack'; path: number[]; ratio: number }
  | { t: 'cmd'; c: 'build'; tile: number; type: number }
  | { t: 'cmd'; c: 'nuke'; from: number; to: number }
  | { t: 'cmd'; c: 'expand'; tile: number }
  | { t: 'cmd'; c: 'invade'; tile: number }
  | { t: 'chat'; text: string }
  | { t: 'leave' }
  | { t: 'ping' };

export interface CreateOpts {
  name?: string;
  maxHumans?: number;
  totalPlayers?: number;
  difficulty?: number;
  seed?: number;
  isPublic?: boolean;
}

// ------------------------------------------------------------
//  Servidor -> Cliente
// ------------------------------------------------------------
export type S2C =
  | { t: 'welcome'; you: number; serverTime: number }
  | { t: 'rooms'; rooms: RoomInfo[] }
  | { t: 'joined'; room: RoomInfo; you: number; players: PlayerSnapshot[]; host: number }
  | { t: 'lobby'; room: RoomInfo; players: PlayerSnapshot[]; host: number }
  | {
      t: 'map';
      w: number;
      h: number;
      terrain: string; // base64 (1 byte por tile)
      changes: Change[];
      players: PlayerSnapshot[];
      you: number;
      room: RoomInfo;
      spectator: boolean;
      rules: { winControl: number; nukeCost: number; costs: Record<string, number> };
    }
  | {
      t: 'tick';
      dt: number;
      changes: Change[];
      players: PlayerSnapshot[];
      events: GameEvent[];
      time: number;
      state: 'waiting' | 'playing' | 'over';
    }
  | { t: 'over'; winner: number; reason: string; players: PlayerSnapshot[] }
  | { t: 'chat'; from: string; text: string; hue?: number }
  | { t: 'err'; msg: string }
  | { t: 'pong'; ms: number };
