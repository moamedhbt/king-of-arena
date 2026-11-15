import raw from '../config.json';

export type Config = typeof raw;
export const config: Config = raw;
export default config;

export const TICK_HZ = raw.net.tickHz;
export const SNAPDT_HZ = raw.net.snapshotHz;
