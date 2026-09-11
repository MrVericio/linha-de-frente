// ============================================================
//  LINHA DE FRENTE — constantes e tipos compartilhados
//  Usado pelo servidor (simulacao autoritativa) e pelo cliente.
// ============================================================

/** Tipos de terreno */
export const T = {
  WATER: 0,
  LAND: 1,
  MOUNTAIN: 2
} as const;

/** Tipos de construcao */
export const B = {
  NONE: 0,
  CITY: 1,
  OUTPOST: 2,
  PORT: 3,
  SILO: 4
} as const;

export const BLD_NAME: Record<number, string> = {
  0: '—',
  1: 'Cidade',
  2: 'Posto Defensivo',
  3: 'Porto',
  4: 'Silo de Mísseis'
};

// ---------------- Mapa ----------------
export const MAP_W = 120;
export const MAP_H = 88;
export const LAND_TARGET = 0.42; // proporcao alvo de terra

// ---------------- Simulacao ----------------
export const TICK_HZ = 20; // ticks de simulacao por segundo (servidor)
export const BROADCAST_HZ = 10; // pacotes de estado por segundo
export const WIN_CONTROL = 0.72; // % do territorio terrestre para vencer

export const TILE_MAX_TROOPS = 130;
export const MOUNTAIN_MAX_TROOPS = 65;
export const CITY_MAX_TROOPS = 1500;
export const OUTPOST_MAX_TROOPS = 320;
export const PORT_MAX_TROOPS = 220;
export const SILO_MAX_TROOPS = 220;

export const GROWTH_RATE = 0.06; // crescimento proporcional por segundo
export const FLAT_GROWTH = 1.1; // crescimento linear por segundo (recupera tile quase vazio)
export const MIN_ATTACK_TROOPS = 2;
export const TRANSFER_RESERVE = 4; // tropas que ficam no tile ao transferir

export const DEF_OUTPOST = 1.4; // multiplicador defensivo
export const DEF_MOUNTAIN = 1.3;
export const DEF_CITY = 1.25;

// ---------------- Economia ----------------
export const GOLD_START = 320;
export const GOLD_PORT_PER_SEC = 4.0; // por porto
export const GOLD_CITY_PER_SEC = 1.6; // por cidade
export const GOLD_TILE_PER_SEC = 0.008; // por tile
export const GOLD_BASE_PER_SEC = 0.5;

export const COSTS: Record<string, number> = {
  city: 400,
  outpost: 250,
  port: 520,
  silo: 1600
};

// ---------------- Armas nucleares ----------------
export const NUKE_COST = 1500;
export const NUKE_COOLDOWN = 12; // segundos
export const NUKE_RANGE = 46; // tiles
export const NUKE_R_CORE = 2.6; // raio de destruicao total
export const NUKE_R_OUTER = 5.2; // raio de dano pesado

// ---------------- Morte subita ----------------
// Depois desse tempo as defesas enfraquecem e os exercitos decaem,
// garantindo que a partida termine em vez de travar em impasse.
export const SUDDEN_DEATH_AT = 480; // segundos
export const SUDDEN_DEATH_DECAY = 0.02; // 2% das tropas por segundo

// ---------------- Partidas ----------------
export const PREMATCH_COUNTDOWN = 20; // segundos no lobby
export const POSTMATCH_SECONDS = 12; // segundos mostrando o placar final
export const DEFAULT_TOTAL_PLAYERS = 12;

// ---------------- Visual ----------------
export const NEUTRAL_HUE = 96; // verde-acinzentado para territorio neutro
export const PLAYER_HUES = [
  4, 210, 46, 130, 285, 190, 24, 320, 96, 258, 168, 60, 350, 226, 78, 300,
  12, 182, 108, 270
];

export const NAMES_BOT = [
  'Bot Anhanguera', 'Bot Ipiranga', 'Bot Guanabara', 'Bot Itatiaia',
  'Bot Corcovado', 'Bot Tietê', 'Bot São Francisco', 'Bot Itacolomi',
  'Bot Roraima', 'Bot Iguaçu', 'Bot Mantiqueira', 'Bot Xingu',
  'Bot Tocantins', 'Bot Paranaíba', 'Bot Araguaia', 'Bot Caparaó',
  'Bot Ipanema', 'Bot Urubupungá', 'Bot Aimorés', 'Bot Diamantina'
];

export interface PlayerSnapshot {
  id: number;
  name: string;
  hue: number;
  bot: boolean;
  diff: number; // 0 facil, 1 normal, 2 dificil
  gold: number;
  alive: boolean;
  tiles: number;
  troops: number;
  buildings: number;
  cities: number;
  ports: number;
  outposts: number;
  silos: number;
  nukeCd: number;
  /** true para quem esta assistindo (entrou com a partida em andamento) */
  spectator?: boolean;
  /** slot liberado (jogador saiu do lobby) — id nunca e reutilizado durante a partida */
  removed?: boolean;
}

export interface GameEvent {
  text: string;
  kind: 'info' | 'war' | 'nuke' | 'build' | 'chat' | 'over';
  hue?: number;
  /** indice do tile relacionado (usado para efeitos visuais, ex.: explosao nuclear) */
  i?: number;
}

/** Mudanca de tile enviada ao cliente: [indice, dono, tropas(int), construcao] */
export type Change = [number, number, number, number];

export interface RoomInfo {
  id: string;
  name: string;
  isPublic?: boolean;
  state: 'waiting' | 'playing' | 'over';
  humans: number;
  total: number;
  maxHumans: number;
  bots: number;
  countdown: number;
  mapSeed: number;
}
