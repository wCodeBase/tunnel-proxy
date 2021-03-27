export interface Target {
    ip: string;
    port: number;
    notProxy?: true;
    fixedDomains?: (string | RegExp)[];
}
export const Settings = {
    socketTimeout: 15000,
    proxys: [] as Target[],
    port: 8008,
    host: '0.0.0.0',
    proxyCostBonus: 30,
    maxPkgLossPct: 50,
    maxGoodLatency: 150,
    pingAsync: true,
    cacheFile: './tunnel-proxy-cache.bin',
};
