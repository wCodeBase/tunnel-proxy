import { diagnoseDomain, tryRestoreCache, trySaveCache } from './stats/channelDiagnostic';
import net, { Socket } from 'net';
import { Settings, Target } from './common/setting';

const CODE_CONNECT = 'CONNECT';
const MAX_HTTP_METHOD_LENGTH = 10;
const MAX_HTTP_URL_LENGTH = 10000;
const CODE_SPACE = ' '.charCodeAt(0);
const PACKAGE_TAIL = Buffer.from('\r\n\r\n');
const CONNECTED_FEEDBACK = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');

const isConnectedMethod = (data: Buffer) =>
    String(data.slice(0, CODE_CONNECT.length)) === CODE_CONNECT;

function RaceSocketOn(event: 'end', listener: () => void): void;
function RaceSocketOn(event: 'error', listener: () => void): void;
// @ts-ignore
function RaceSocketOn(event: 'data', listener: (data: Buffer) => void): void;

type RaceSocket = Pick<Socket, 'destroy'> & {
    on: typeof RaceSocketOn;
    write: (data: Buffer) => void;
};
const closedSockSet = new Set();

function parseHttpUrl(data: Buffer) {
    const start = data.slice(0, MAX_HTTP_METHOD_LENGTH).indexOf(CODE_SPACE);
    if (start < 0) return null;
    const end = data.slice(start + 1, MAX_HTTP_URL_LENGTH).indexOf(CODE_SPACE);
    if (end < 0) return null;
    return String(data.slice(start + 1, start + end + 1));
}

function parseDomainAndPort(data: Buffer) {
    const url = parseHttpUrl(data);
    if (!url) return null;
    const domainAndPort = url
        .replace(/https?:\/\//, '')
        .replace(/\/.*/, '')
        .split(':');
    const domain = domainAndPort[0];
    const port = domainAndPort.length > 1 ? Number(domainAndPort[1]) : 80;
    return [domain, port] as [string, number];
}

/**
 * 通过比较第一个包的响应时间选取最快的路线
 * @param connectData 当请求的方法是CONNECT时需传递
 */
function raceConnect(dests: Target[], connectData?: Buffer, domain?: string): RaceSocket {
    const dataCache: Buffer[] = [];
    let msock: Socket | null = null;
    let connectedSocks: Socket[] = [];
    const cbMap: { [index: string]: (...args: Buffer[]) => void } = {};
    const raceRecvDataMap = new Map<Socket, Buffer[]>();
    let minRacingCost = Infinity;
    let minRecvSock: Socket | null = null;
    let minCancelCb: (() => void) | null = null;
    let judgeTimeOut = -Infinity;
    const judgeWin = (isTimeout = true) => {
        const win = isTimeout || socks.filter((v) => v).length === 1;
        if (win && minRecvSock) {
            msock = minRecvSock;
            minRecvSock = null;
            minCancelCb = null;
            socks.forEach((v) => v !== msock && v?.destroy());
            ['data', 'end', 'error'].forEach((ev) =>
                msock?.on(ev, (...args) => cbMap[ev]?.(...args)),
            );
            raceRecvDataMap.get(msock)?.forEach((d) => cbMap['data']?.(d));
        }
        return win;
    };
    const socks: (Socket | null)[] = dests.map((v, i) => {
        let blockDataCount = 0;
        let raceStartAt = -Infinity;
        const sock = net.connect(v.port, v.ip, () => {
            if (connectData && !v.notProxy) {
                sock.write(connectData);
                blockDataCount++;
            } else {
                dataCache.forEach((d) => sock.write(d));
                connectedSocks.push(sock);
                raceStartAt = Date.now();
            }
        });
        const fail = () => {
            if (minRecvSock === sock) {
                clearTimeout(judgeTimeOut);
                judgeTimeOut = -Infinity;
                minCancelCb = null;
                minRecvSock = null;
                minRacingCost = Infinity;
            }
            sock.destroy();
            socks[i] = null;
            connectedSocks = connectedSocks.filter((v) => v !== sock);
            if (!socks.find((v) => v)) cbMap['error']?.();
        };
        sock.on('end', () => {
            closedSockSet.add(sock);
            if (sock === msock) cbMap['end']?.();
        });
        sock.on('data', (data) => {
            if (blockDataCount) {
                // TODO: 解析代理返回的错误
                blockDataCount--;
                if (blockDataCount <= 0) {
                    dataCache.forEach((d) => sock.write(d));
                    connectedSocks.push(sock);
                    raceStartAt = Date.now();
                }
                return;
            }
            if (msock) return;
            const mCache = raceRecvDataMap.get(sock);
            if (mCache) {
                mCache.push(data);
                return;
            }
            let cost = Date.now() - raceStartAt;
            if (v.notProxy && dests.find((v) => !!v.notProxy)) cost += Settings.proxyCostBonus;
            if (cost >= minRacingCost) fail();
            else {
                minRacingCost = cost;
                minRecvSock = sock;
                raceRecvDataMap.set(sock, [data]);
                minCancelCb?.();
                minCancelCb = fail;
                if (!judgeWin(false) && judgeTimeOut === -Infinity)
                    judgeTimeOut = Number(setTimeout(judgeWin, cost));
            }
        });
        sock.on('error', fail);
        sock.setTimeout(Settings.socketTimeout, fail);
        return sock;
    });
    setTimeout(() => {
        if (!msock) {
            socks.forEach((s) => s?.destroy());
            cbMap['error']?.();
        }
    }, Settings.socketTimeout);
    return {
        write(data) {
            if (!msock) {
                dataCache.push(data);
                connectedSocks.forEach((s) => s.write(data));
            } else msock.write(data);
        },
        destroy() {
            msock?.destroy();
            socks.forEach((s) => s?.destroy());
        },
        on(ev: string, cb: (data: Buffer) => void) {
            cbMap[ev] = cb;
        },
    };
}

function sockConnect(
    sock: Socket,
    targets: Target[],
    firstData: Buffer,
    domain: string,
    port: number,
) {
    if (!targets.length) {
        sock.destroy();
        return;
    }
    const dAndP = domain + ':' + port;
    const isConnect = isConnectedMethod(firstData);
    const connectData = isConnect ? firstData : undefined;
    const destSock = raceConnect(targets, connectData, domain);
    /**
     * ${isConnect === false} means this is a http (not https) proxy request, which may recieve requests for multi domain.
     * In this case, it's necessary to create multi destSocks for different domain.
     * Use this map to store domain-sock mapping relations;
     */
    const restDestSockMap = isConnect ? null : new Map([[dAndP, destSock]]);
    const genDestEnd = (dAndP: string) => () => {
        if (!restDestSockMap) sock.destroy();
        else {
            restDestSockMap.get(dAndP)?.destroy();
            restDestSockMap.delete(dAndP);
        }
    };
    const destEnd = genDestEnd(dAndP);
    const end = () => {
        if (!restDestSockMap) destSock.destroy();
        else Array.from(restDestSockMap.values()).forEach((s) => s.destroy());
    };
    const onDataBack = (data: Buffer) => {
        sock.write(data);
    };
    destSock.on('end', destEnd);
    destSock.on('error', destEnd);
    destSock.on('data', onDataBack);
    let lastDAndP = dAndP;
    sock.on('data', async (data) => {
        if (restDestSockMap) {
            if (lastDAndP) {
                restDestSockMap.get(lastDAndP)?.write(data);
            } else {
                const domainAndPort = parseDomainAndPort(data);
                if (!domainAndPort) destSock.write(data);
                else {
                    const [domain, port] = domainAndPort;
                    const dAndP = `${domain}:${port}}`;
                    lastDAndP = dAndP;
                    let sock = restDestSockMap.get(dAndP);
                    if (!sock) {
                        const target = getDomainProxy(domain);
                        const targets = target ? [target] : await diagnoseDomain(domain, port);
                        sock = raceConnect(targets, undefined, domain);
                        restDestSockMap.set(dAndP, sock);
                    }
                    sock.write(data);
                }
            }
            if (data.includes(PACKAGE_TAIL)) {
                lastDAndP = '';
                if (Settings.forceSeperateHttpRequest) sock.destroy();
            }
        } else destSock.write(data);
    });
    sock.on('end', end);
    sock.on('error', end);
    if (connectData) sock.write(CONNECTED_FEEDBACK);
    else destSock.write(firstData);
}

const getDomainProxy = (() => {
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
})();

export function startProxy(): void {
    tryRestoreCache();

    const sockIpHostSet = new Set<string>();

    const server = new net.Server((sock) => {
        const strIpHost = `${sock.remoteAddress}:${sock.remotePort}`;
        if (sockIpHostSet.has(strIpHost)) {
            sock.destroy();
            return;
        }
        sockIpHostSet.add(strIpHost);
        sock.on('end', () => {
            sockIpHostSet.delete(strIpHost);
        });
        sock.once('data', async (data) => {
            const domainAndPort = parseDomainAndPort(data);
            if (!domainAndPort) {
                // TODO: 返回错误信息, 可开关
                sock.destroy();
                return;
            }
            const [domain, port] = domainAndPort;
            const target = getDomainProxy(domain);
            if (target) sockConnect(sock, [target], data, domain, port);
            else {
                const targets = await diagnoseDomain(domain, port);
                sockConnect(sock, targets, data, domain, port);
            }
        });
    });
    server.listen(Settings.port, Settings.host);
    console.log(`Proxy listening on ${Settings.host}:${Settings.port}`);
    process.on('SIGINT', async () => {
        await trySaveCache();
        process.exit();
    });
    process.on('SIGTERM', async () => {
        await trySaveCache();
        process.exit();
    });
}
