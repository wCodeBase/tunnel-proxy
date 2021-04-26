import { deflate, unzip } from 'zlib';
import { Settings } from './setting';
import { networkInterfaces } from 'os';

const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
export function genRandomString(length: number) {
    let res = '';
    while (length--) res += chars[Math.floor(Math.random() * chars.length)];
    return res;
}

/**
 * Parse a `domain:port` string.
 * If there is no `:port` part in given string, the port returned will be 80;
 */
export function parseDomain(domain: string) {
    const domainAndPort = domain.split(':');
    return {
        domain: domainAndPort[0],
        port: domainAndPort.length > 1 ? Number(domainAndPort[1]) : 80,
    };
}

export function zipData(data: Buffer): Promise<Buffer> {
    return new Promise((r, j) => {
        deflate(data, (err, res) => {
            if (err) j(err);
            else r(res);
        });
    });
}

export function unZipipData(data: Buffer): Promise<Buffer> {
    return new Promise((r, j) => {
        unzip(data, (err, res) => {
            if (err) j(err);
            else r(res);
        });
    });
}

export function runWithTimeout<T, V>(
    worker: Promise<T>,
    timeout: number,
    timeoutValue: V,
): Promise<T | V> {
    if (timeout === Infinity) return worker;
    return Promise.race([
        worker,
        new Promise<V>((r) => setTimeout(() => r(timeoutValue), timeout)),
    ]);
}

/**
 *
 * The native setTimeout function will ignore time-cost during system sleeping.
 *
 * So use this to gain "realTimeout", which using system time to calculate wether time is out or not.
 *
 * Working by polling and native setTimeout with time unit setting on "Settings.timeoutUnit".
 *
 */
export const realTimeout = (() => {
    let cbPairs: { at: number; cb: () => void }[] = [];
    let intervalCbPairs: { interval: number; cb: () => void; last?: number }[] = [];
    const tryRun = (cb: () => void) => {
        try {
            cb();
        } catch (e) {
            console.log('error in realTimeout cb: ', e);
        }
    };
    const deamonCb = () => {
        setTimeout(deamonCb, Settings.timeoutUnit);
        const now = Date.now();
        cbPairs = cbPairs.filter((v) => {
            if (v.at > now) return true;
            tryRun(v.cb);
        });
        intervalCbPairs.forEach((v) => {
            if (!v.last || v.last + v.interval < now) {
                tryRun(v.cb);
                v.last = Date.now();
            }
        });
    };
    deamonCb();
    return {
        setTimeout: (cb: () => void, timeout: number) =>
            cbPairs.push({ at: Date.now() + timeout, cb }),
        clearTimeout: (cb: () => void) => (cbPairs = cbPairs.filter((v) => v.cb !== cb)),
        setInterval: (cb: () => void, interval: number) => intervalCbPairs.push({ interval, cb }),
        clearInterval: (cb: () => void) =>
            (intervalCbPairs = intervalCbPairs.filter((v) => v.cb !== cb)),
    };
})();

export const getIpAddressList = () => {
    let ipList: string[] = [];
    Object.entries(networkInterfaces()).forEach(([dev, info]) => {
        if (info) ipList = ipList.concat(info.map((v) => v.address));
    });
    return ipList;
};

export const batchFilter = async <T>(
    datas: T[],
    cb: (data: T) => Promise<boolean>,
    batchCount = 30,
) => {
    if (batchCount <= 0) batchCount = 3;
    const res = [] as T[];
    const src = [...datas];
    await Promise.all(
        new Array(batchCount).fill(1).map(async () => {
            while (src.length) {
                const item = src.pop();
                if (item && (await cb(item))) res.push(item);
            }
        }),
    );
    return res;
};
