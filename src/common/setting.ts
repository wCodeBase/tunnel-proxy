import { ProtocolBase } from './types';

export interface Target {
    ip: string;
    port: number;
    notProxy?: true;
    fixedDomains?: (string | RegExp)[];
}
export const isDev = process.env.NODE_ENV === 'development';

export enum ErrorLevel {
    off,
    dangerous,
    important,
    /** Errorlevel warn means may affect proxy usage, such as a main connection failed. */
    warn,
    /** Errorlevel debugDetail means info may helpful for debug, such as one race connection failed. */
    debugDetail,
    notice,
    all = 10000,
}
export enum LogLevel {
    off,
    important,
    notice,
    detail,
    noisyDetail,
    all = 10000,
}
export const Settings = {
    socketConnectTimeout: 15000,
    socketIdleTimeout: 4000,
    socketIdleReverifyWaitMilli: 30000,
    goodSocketTimeout: 300,
    notExactlyGoodCountLimit: 3.5,
    inSocketMaxRetry: 3,
    inSocketRetryDelay: 300,
    proxys: [] as Target[],
    port: 8008,
    host: '0.0.0.0',
    proxyCostBonus: 10,
    actionRaceCostRate: 3,
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
    errorLevel: isDev ? ErrorLevel.warn : ErrorLevel.off,
    errorFilter: (target?: Target, protocol?: ProtocolBase) => true, // eslint-disable-line @typescript-eslint/no-unused-vars
    logLevel: isDev ? LogLevel.important : LogLevel.off,
    logFilter: (target?: Target, protocol?: ProtocolBase) => true, // eslint-disable-line @typescript-eslint/no-unused-vars
    loggerTime: true,
    loggerFoldToLenLimit: 80,
    loggerInfoStringify: false,
};

export const overrideSetting = (settings: Partial<typeof Settings>) => {
    Object.assign(Settings, settings);
    getDomainProxy = genGetDomainProxy();
};

// TODO: return targets,rather than first match target.
const genGetDomainProxy = () => {
    const domainTargetMap = new Map<string, Target>();
    const domainProxyPairs: [string | RegExp, Target][] = [];
    Settings.proxys.forEach((target) => {
        target.fixedDomains?.forEach((s) => domainProxyPairs.push([s, target]));
    });

    return (domain: string) => {
        let target = domainTargetMap.get(domain);
        if (target) return target;
        domainProxyPairs.some((v) => {
            if (domain.match(v[0])) {
                target = v[1];
                domainTargetMap.set(domain, target);
                return true;
            }
        });
        return target;
    };
};
/**
 * Parse proxy-domain map from Settings and retrun a method for query.
 */
export let getDomainProxy = genGetDomainProxy();
