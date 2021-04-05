import { deflate, unzip } from 'zlib';

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
