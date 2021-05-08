import { logger } from './logger';

import net, { Socket } from 'net';
import { notExactlyGoodStats } from '../stats/channelDiagnostic';
import { Settings, ErrorLevel, LogLevel } from './setting';
import {
    DomainChannelStats,
    ErrorRaceFail,
    ErrorIdleTimeout,
    LogicConnect,
    SocketTargetPair,
    LogicSocket,
} from './types';

/**
 * 通过比较第一个包的响应时间选取最快的路线
 * @param connectData 当请求的方法是CONNECT时需传递
 */
export const raceConnect: LogicConnect = (targets, protocol) => {
    const haveProxy = !!targets.find((v) => !v.target.notProxy);
    let finished = false;
    let maxRecvCount = 0;
    const dataCache: Buffer[] = [];
    let msockPair: SocketTargetPair | null = null;
    let connectedSocks: SocketTargetPair[] = [];
    const cbMap: { [index: string]: (...args: (Buffer | Error)[]) => void } = {};
    let connectCb: null | (() => void) = () => {
        cbMap['connect']?.();
        connectCb = null;
    };
    const raceRecvDataMap = new Map<Socket, Buffer[]>();
    let minRacingCost = Infinity;
    let minRecvSockPair: SocketTargetPair | null = null;
    let minCancelCb: (() => void) | null = null;
    let judgeTimeOut = -Infinity;
    const judgeWin = (isTimeout = true) => {
        if (msockPair) return;
        const win = isTimeout || socks.filter((v) => v).length === 1;
        if (win && minRecvSockPair) {
            msockPair = minRecvSockPair;
            minRecvSockPair = null;
            minCancelCb = null;
            socks.forEach((v) => v !== msockPair?.sock && v?.destroy());
            ['data', 'end', 'error'].forEach((ev) =>
                msockPair?.sock.on(
                    ev,
                    ev === 'error'
                        ? (err) => {
                              logger.error(
                                  ErrorLevel.warn,
                                  undefined,
                                  protocol,
                                  'Msock(race win sock) on error',
                                  err,
                                  targets,
                              );
                          }
                        : cbMap[ev],
                ),
            );
            raceRecvDataMap.get(msockPair.sock)?.forEach((d) => cbMap['data']?.(d));
            // raceRecvDataMap.clear();
        }
        return win;
    };
    const sockMapper = (domainStats: DomainChannelStats, i: number) => {
        const target = domainStats.target;
        let retryCount = 0;
        const raceRetry = async () => {
            await new Promise((r) => setTimeout(r, Settings.inSocketRetryDelay));
            retryCount++;
            if (msockPair || minRecvSockPair || retryCount > Settings.inSocketMaxRetry || finished)
                return;
            socks[i] = createSock();
            return true;
        };
        const createSock = () => {
            const raceStartAt = Date.now(),
                dataStartAt = 0;
            let recvCount = 0;
            let lastTimeoutVerifyAt = 0;
            const sock: Socket = net.connect(target.port, target.ip, async () => {
                try {
                    logger.log(
                        LogLevel.detail,
                        target,
                        protocol,
                        'Connect to target and call onLogicConnect',
                    );
                    await protocol.onLogicConnect(target, sock);
                } catch (e) {
                    logger.error(
                        ErrorLevel.debugDetail,
                        target,
                        protocol,
                        'Protocol connect failed:',
                        e,
                    );
                    fail(await raceRetry());
                    return;
                }
                connectedSocks.push({ sock, target });
                sock.on('data', onData);
                dataStartAt = Date.now();
                connectCb?.();
                dataCache.forEach((d) => protocol.writeToTargetSock(d, sock, target));
            });
            const onData = (data: Buffer) => {
                logger.log(
                    LogLevel.detail,
                    target,
                    protocol,
                    'On race data:',
                    data.length,
                    msockPair,
                );
                recvCount++;
                maxRecvCount = Math.max(recvCount, maxRecvCount);
                if (msockPair) {
                    // if (msockPair.sock === sock) sock.removeListener('data', onData);
                    if (msockPair.sock !== sock && domainStats.status === 'good')
                        notExactlyGoodStats.feedback(true, protocol.addr);
                    return;
                }
                const mCache = raceRecvDataMap.get(sock);
                if (mCache) {
                    mCache.push(data);
                    return;
                }
                const now = Date.now();
                const actionCost = now - dataStartAt;
                const raceCost = now - raceStartAt;
                let weightedCost = actionCost * Settings.actionRaceCostRate + raceCost;
                const costBonused = target.notProxy && haveProxy ? Settings.proxyCostBonus : 0;
                weightedCost += costBonused;
                if (weightedCost >= minRacingCost) fail(new ErrorRaceFail('Error: race failed'));
                else {
                    minRacingCost = weightedCost;
                    minRecvSockPair = { sock, target };
                    raceRecvDataMap.set(sock, [data]);
                    minCancelCb?.();
                    minCancelCb = () =>
                        fail(new ErrorRaceFail('Error: race failed becouse min cancelled'));
                    if (!judgeWin(false) && judgeTimeOut === -Infinity) {
                        judgeTimeOut = Number(setTimeout(judgeWin, costBonused + actionCost));
                        if (target.notProxy && actionCost + raceCost < Settings.goodSocketTimeout)
                            notExactlyGoodStats.feedback(false, protocol.addr);
                        else if (targets.find((v) => v.status === 'good'))
                            notExactlyGoodStats.feedback(true, protocol.addr);
                    }
                }
            };
            const fail = async (errorOrRetry?: Error | true) => {
                if (finished) return;
                // If error type is ErrorIdleTimeout, use another request to verify network.
                if (
                    errorOrRetry instanceof ErrorIdleTimeout &&
                    recvCount >= protocol.minCountShouldIdleTimeoutRecv
                ) {
                    if (lastTimeoutVerifyAt > Date.now() - Settings.socketIdleReverifyWaitMilli)
                        return;
                    lastTimeoutVerifyAt = Date.now();
                    if (await protocol.doIdleTimeoutVerify(domainStats.target)) {
                        logger.log(LogLevel.notice, target, protocol, 'Idle verify success');
                        return;
                    } else {
                        logger.error(
                            ErrorLevel.debugDetail,
                            target,
                            protocol,
                            'Idle verify failed',
                        );
                    }
                }
                if (target.notProxy && domainStats.status === 'good') {
                    notExactlyGoodStats.feedback(true, protocol.addr);
                }
                if (minRecvSockPair?.sock === sock) {
                    clearTimeout(judgeTimeOut);
                    judgeTimeOut = -Infinity;
                    minCancelCb = null;
                    minRecvSockPair = null;
                    minRacingCost = Infinity;
                }
                sock.destroy();
                socks[i] = null;
                connectedSocks = connectedSocks.filter((v) => v.sock !== sock);
                if (msockPair?.sock === sock || (errorOrRetry !== true && !socks.find((v) => v))) {
                    const error =
                        errorOrRetry instanceof Error
                            ? errorOrRetry
                            : new Error('Race connect fail: all sock invalid');
                    logger.error(
                        ErrorLevel.warn,
                        target,
                        protocol,
                        'All race connection failed',
                        error,
                        target,
                        targets,
                    );
                    cbMap['error']?.(error);
                    finished = true;
                }
            };
            sock.on('end', () => {
                if (sock === msockPair?.sock) {
                    cbMap['end']?.();
                    finished = true;
                } else if (!recvCount) raceRetry();
            });
            sock.on('error', fail);
            sock.setTimeout(Settings.socketIdleTimeout, () => {
                fail(new ErrorIdleTimeout('Error: socket time out'));
            });
            return sock;
        };
        return createSock();
    };
    const socks: (Socket | null)[] = targets.map(sockMapper);
    /**
     * If proxies exist and only one taget passed，means the only target is good.
     * Here to do correction if the good target is not good exactly.
     */
    if (Settings.proxys.length && targets.length === 1 && targets[0].target.notProxy) {
        setTimeout(() => {
            if (msockPair || finished) return;
            notExactlyGoodStats.feedback(true, protocol.addr);
            const { port, dAndP } = targets[0];
            Settings.proxys.forEach((target) =>
                socks.push(
                    sockMapper(
                        new DomainChannelStats(protocol.addr, port, dAndP, target),
                        socks.length,
                    ),
                ),
            );
        }, Settings.goodSocketTimeout);
    }

    setTimeout(() => {
        if (!msockPair) {
            socks.forEach((s) => s?.destroy());
            const error = new Error('Socket connect Timeout');
            logger.error(ErrorLevel.warn, undefined, protocol, error, targets);
            cbMap['error']?.(error);
            finished = true;
        }
    }, Settings.socketConnectTimeout);
    return {
        write(data) {
            if (!msockPair) {
                dataCache.push(data);
                connectedSocks.forEach((s) => protocol.writeToTargetSock(data, s.sock, s.target));
            } else protocol.writeToTargetSock(data, msockPair.sock, msockPair.target);
        },
        destroy() {
            logger.log(LogLevel.detail, undefined, protocol, 'RaceConnect Destory called', targets);
            finished = true;
            msockPair?.sock?.destroy();
            socks.forEach((s) => s?.destroy());
        },
        on: (ev: string | number, cb: (...args: any) => void) => {
            cbMap[ev] = cb;
        },
    } as LogicSocket;
};
