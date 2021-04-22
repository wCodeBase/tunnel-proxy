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
    pingTimeout: 10,
    pingBatchCount: 100,
    dnsTimeout: 10000,
    cacheFile: './tunnel-proxy-cache.bin',
    /** Set to true may help speeding up page switching when using Firefox */
    forceSeperateHttpRequest: false,
    /** time unit (in millisecond) for the realTimeout methods */
    timeoutUnit: 500,
};
