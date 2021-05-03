import { ErrorRaceFail, ErrorIdleTimeout, DomainChannelStats } from './stats/types';
import {
    diagnoseDomain,
    tryRestoreCache,
    trySaveCache,
    notExactlyGoodStats,
} from './stats/channelDiagnostic';
import net, { Socket } from 'net';
import { Settings, Target } from './common/setting';

const CODE_CONNECT = 'CONNECT';
const MAX_HTTP_METHOD_LENGTH = 10;
const MAX_HTTP_URL_LENGTH = 10000;
const CODE_SPACE = ' '.charCodeAt(0);
const PACKAGE_TAIL = Buffer.from('\r\n\r\n');
const CONNECTED_FEEDBACK = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
const CONNECTION_ESTABLISHED = Buffer.from('Connection Established');
const CONNECT_FAILED_FEEDBACK = Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n');

const isConnectedMethod = (data: Buffer) =>
    String(data.slice(0, CODE_CONNECT.length)) === CODE_CONNECT;

function RaceSocketOn(event: 'end', listener: () => void): void;
function RaceSocketOn(event: 'error', listener: () => void): void;
function RaceSocketOn(event: 'connect', listener: () => void): void;
// @ts-ignore
function RaceSocketOn(event: 'data', listener: (data: Buffer) => void): void;

type RaceSocket = Pick<Socket, 'destroy'> & {
    on: typeof RaceSocketOn;
    write: (data: Buffer) => void;
};

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
function raceConnect(
    dests: DomainChannelStats[],
    domain: string,
    connectData?: Buffer,
): RaceSocket {
    const haveProxy = !!dests.find((v) => !v.target.notProxy);
    let finished = false;
    let maxRecvCount = 0;
    const dataCache: Buffer[] = [];
    let msock: Socket | null = null;
    let connectedSocks: Socket[] = [];
    const cbMap: { [index: string]: (...args: Buffer[]) => void } = {};
    let connectCb: null | (() => void) = () => {
        cbMap['connect']?.();
        connectCb = null;
    };
    const raceRecvDataMap = new Map<Socket, Buffer[]>();
    let minRacingCost = Infinity;
    let minRecvSock: Socket | null = null;
    let minCancelCb: (() => void) | null = null;
    let judgeTimeOut = -Infinity;
    const judgeWin = (isTimeout = true) => {
        if (msock) return;
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
        connectCb?.();
        return win;
    };
    const sockMapper = (domainStats: DomainChannelStats, i: number) => {
        const v = domainStats.target;
        let retryCount = 0;
        const reacRetry = async () => {
            await new Promise((r) => setTimeout(r, Settings.inSocketRetryDelay));
            retryCount++;
            if (msock || minRecvSock || retryCount > Settings.inSocketMaxRetry || finished) return;
            socks[i] = createSock();
        };
        const createSock = () => {
            let blockDataCount = 0;
            let raceStartAt = 0;
            let recvCount = 0;
            const sock = net.connect(v.port, v.ip, () => {
                if (connectData) {
                    blockDataCount++;
                    if (!v.notProxy) sock.write(connectData);
                    else onData(CONNECTED_FEEDBACK);
                } else {
                    dataCache.forEach((d) => {
                        if (v.notProxy && v.ip === domain) {
                            // Remove schema and domain info in http request to avoid 404 error in "python3 -m http.server"
                            const spaceAt = d.indexOf(CODE_SPACE);
                            if (spaceAt > 0) {
                                const secondSpaceAt = d.indexOf(CODE_SPACE, spaceAt + 1);
                                if (secondSpaceAt >= 0) {
                                    const url = String(d.slice(spaceAt + 1, secondSpaceAt)).replace(
                                        /https?:\/\/[^/]*/,
                                        '',
                                    );
                                    d = Buffer.concat([
                                        d.slice(0, spaceAt + 1),
                                        Buffer.from(url),
                                        d.slice(secondSpaceAt),
                                    ]);
                                }
                            }
                        }
                        sock.write(d);
                    });
                    connectedSocks.push(sock);
                    if (!raceStartAt) raceStartAt = Date.now();
                }
            });
            const onData = (data: Buffer) => {
                recvCount++;
                maxRecvCount = Math.max(recvCount, maxRecvCount);
                if (blockDataCount) {
                    // TODO: 解析代理返回的错误
                    blockDataCount--;
                    if (connectCb && data.includes(CONNECTION_ESTABLISHED)) {
                        connectCb();
                    }
                    if (blockDataCount <= 0) {
                        dataCache.forEach((d) => sock.write(d));
                        connectedSocks.push(sock);
                        if (!raceStartAt) raceStartAt = Date.now();
                    }
                    return;
                }
                if (msock) {
                    if (msock === sock) sock.removeListener('data', onData);
                    if (msock !== sock && domainStats.status === 'good')
                        notExactlyGoodStats.feedback(true, domain);
                    return;
                }
                const mCache = raceRecvDataMap.get(sock);
                if (mCache) {
                    mCache.push(data);
                    return;
                }
                let cost = Date.now() - raceStartAt;
                const costBonused = v.notProxy && haveProxy ? Settings.proxyCostBonus : 0;
                cost += costBonused;
                if (cost >= minRacingCost) fail(new ErrorRaceFail('Error: race failed'));
                else {
                    minRacingCost = cost;
                    minRecvSock = sock;
                    raceRecvDataMap.set(sock, [data]);
                    minCancelCb?.();
                    minCancelCb = fail;
                    if (!judgeWin(false) && judgeTimeOut === -Infinity) {
                        judgeTimeOut = Number(setTimeout(judgeWin, costBonused));
                        if (v.notProxy && cost < Settings.goodSocketTimeout)
                            notExactlyGoodStats.feedback(false, domain);
                        else if (dests.find((v) => v.status === 'good'))
                            notExactlyGoodStats.feedback(true, domain);
                    }
                }
            };
            const fail = (error?: Error) => {
                // TODO: Maybe need to verify error type.
                if (v.notProxy && domainStats.status === 'good') {
                    notExactlyGoodStats.feedback(true, domain);
                }
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
                if (msock === sock || !socks.find((v) => v)) {
                    cbMap['error']?.();
                    finished = true;
                }
            };
            sock.on('end', () => {
                if (sock === msock) {
                    cbMap['end']?.();
                    finished = true;
                } else if (!recvCount) reacRetry();
            });
            sock.on('data', onData);
            sock.on('error', fail);
            // TODO: checkout whether idle websocket trigger timeout or not.
            sock.setTimeout(Settings.socketIdleTimeout, () =>
                fail(new ErrorIdleTimeout('Error: socket time out')),
            );
            return sock;
        };
        return createSock();
    };
    const socks: (Socket | null)[] = dests.map(sockMapper);
    /**
     * If proxies exist and only one taget passed，means the only target is good.
     * Here to do correction if the good target is not good exactly.
     */
    if (Settings.proxys.length && dests.length === 1 && dests[0].target.notProxy) {
        setTimeout(() => {
            if (msock || finished) return;
            notExactlyGoodStats.feedback(true, domain);
            const { port, dAndP } = dests[0];
            Settings.proxys.forEach((target) =>
                socks.push(
                    sockMapper(new DomainChannelStats(domain, port, dAndP, target), socks.length),
                ),
            );
        }, Settings.goodSocketTimeout);
    }

    setTimeout(() => {
        if (!msock) {
            socks.forEach((s) => s?.destroy());
            cbMap['error']?.();
            finished = true;
        }
    }, Settings.socketConnectTimeout);
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
    targets: DomainChannelStats[],
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
    const destSock = raceConnect(targets, domain, connectData);
    /**
     * ${isConnect === false} means this is a http (not https) proxy request, which may recieve requests for multi domain.
     * In this case, it's necessary to create multi destSocks for different domain.
     * Use this map to store domain-sock mapping relations;
     */
    const restDestSockMap = isConnect ? null : new Map([[dAndP, destSock]]);
    const genDestEnd = (dAndP: string, isError = false) => () => {
        const destory = () => {
            if (isError) sock.write(CONNECT_FAILED_FEEDBACK);
            sock.destroy();
        };
        if (!restDestSockMap) destory();
        else {
            restDestSockMap.get(dAndP)?.destroy();
            restDestSockMap.delete(dAndP);
            if (!restDestSockMap.size) destory();
        }
    };
    const destEnd = genDestEnd(dAndP);
    const destError = genDestEnd(dAndP, true);
    const end = () => {
        if (!restDestSockMap) destSock.destroy();
        else Array.from(restDestSockMap.values()).forEach((s) => s.destroy());
    };
    const onDataBack = (data: Buffer) => {
        sock.write(data);
    };
    const bindSock = (rSock: RaceSocket) => {
        rSock.on('connect', () => {
            sock.write(CONNECTED_FEEDBACK);
        });
        rSock.on('end', destEnd);
        rSock.on('error', destError);
        rSock.on('data', onDataBack);
    };
    bindSock(destSock);
    let lastDAndP = firstData.slice(-PACKAGE_TAIL.length).includes(PACKAGE_TAIL) ? '' : dAndP;
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
                        const domainStats = target
                            ? [new DomainChannelStats(domain, port, dAndP, target)]
                            : await diagnoseDomain(domain, port);
                        sock = raceConnect(domainStats, domain, undefined);
                        restDestSockMap.set(dAndP, sock);
                        bindSock(sock);
                    }
                    sock.write(data);
                }
            }
            if (data.slice(-PACKAGE_TAIL.length).includes(PACKAGE_TAIL)) {
                lastDAndP = '';
                if (Settings.forceSeperateHttpRequest) sock.destroy();
            }
        } else destSock.write(data);
    });
    sock.on('end', end);
    sock.on('error', end);
    if (!connectData) destSock.write(firstData);
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
        // TODO: socks5 proxy
        sock.once('data', async (data) => {
            const domainAndPort = parseDomainAndPort(data);
            if (!domainAndPort) {
                // TODO: 返回错误信息, 可开关
                sock.destroy();
                return;
            }
            const [domain, port] = domainAndPort;
            const target = getDomainProxy(domain);
            if (target)
                sockConnect(
                    sock,
                    [new DomainChannelStats(domain, port, `${domain}:${port}`, target)],
                    data,
                    domain,
                    port,
                );
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
