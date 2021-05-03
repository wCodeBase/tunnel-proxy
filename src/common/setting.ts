export interface Target {
    ip: string;
    port: number;
    notProxy?: true;
    fixedDomains?: (string | RegExp)[];
}
export const Settings = {
    socketConnectTimeout: 15000,
    socketIdleTimeout: 4000,
    goodSocketTimeout: 300,
    notExactlyGoodCountLimit: 3.5,
    inSocketMaxRetry: 3,
    inSocketRetryDelay: 300,
    proxys: [] as Target[],
    port: 8008,
    host: '0.0.0.0',
    proxyCostBonus: 30,
    maxPkgLossPct: 50,
    maxGoodLatency: 150,
    pingAsync: true,
    pingTimeout: 10,
    pingBatchCount: 50,
    dnsTimeout: 10000,
    cacheFile: './tunnel-proxy-cache.bin',
    /**
     * After how much hours of inactive period a cached domain should be judge to clean.
     *
     * Each time a domain is judged to clean, it's count will be devidied by 3, until 0,
     * which means this domain is to be deleted.
     */
    cacheDomainLife: 30 * 24,
    /** Set to true may help speeding up page switching when using Firefox */
    forceSeperateHttpRequest: false,
    /** time unit (millisecond) for the realTimeout methods */
    timeoutUnit: 500,
    useIpv6: false,
};
