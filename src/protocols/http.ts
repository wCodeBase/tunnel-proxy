import { HttpsProxyAgent } from 'https-proxy-agent';
import { Socket } from 'net';
import nFetch from 'node-fetch';
import { ErrorLevel, LogLevel, Settings, Target } from '../common/setting';
import { getTargets } from '../stats/channelDiagnostic';
import { logger } from './../common/logger';
import {
    DomainChannelStats,
    ErrorProtocolProcessing,
    LogicSocket,
    ProtocolBase,
} from './../common/types';
/***
 * Protocol processor for http and https.
 **/
import { safeCloseSocket, writeSocketForAck } from './../common/util';

const CODE_CONNECT = 'CONNECT';
const MAX_HTTP_METHOD_LENGTH = 10;
const MAX_HTTP_URL_LENGTH = 100000;
const CODE_SPACE = ' '.charCodeAt(0);
const LINE_END = Buffer.from('\r\n');
const PACKAGE_TAIL = Buffer.from('\r\n\r\n');
const CONNECTED_FEEDBACK = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
const CONNECTION_ESTABLISHED = Buffer.from('Connection Established');
const CONNECT_FAILED_FEEDBACK = Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n');
const HTTP_RESPONSE_HEAD_CHARS = Buffer.from('HTTP/');
const HTTP_LOWER_CASE = 'http';

function parseHttpFirstLine(data: Buffer) {
    const start = data.indexOf(CODE_SPACE);
    if (start < 0 || start > MAX_HTTP_METHOD_LENGTH) return null;
    const lineEnd = data.indexOf(LINE_END);
    if (lineEnd > MAX_HTTP_URL_LENGTH) return null;
    const end = data.indexOf(CODE_SPACE, start + 1);
    if (end < 0 || end > MAX_HTTP_URL_LENGTH) return null;
    return {
        method: String(data.slice(0, start)),
        url: String(data.slice(start + 1, end)),
        version: String(data.slice(end + 1, lineEnd)),
    };
}

function parseAddrAndPort(data: Buffer) {
    const info = parseHttpFirstLine(data);
    if (!info) return null;
    const { url, method, version } = info;
    let protocol = url.slice(0, url[5] === 's' ? 5 : 4);
    if (protocol.indexOf('http') !== 0) protocol = '';
    const domainAndPort = url
        .replace(/https?:\/\//, '')
        .replace(/\/.*/, '')
        .split(':');
    const addr = domainAndPort[0];
    const port = domainAndPort.length > 1 ? Number(domainAndPort[1]) : 80;
    return { method, version, addr, port, protocol };
}

const parseResponseHeader = (data: Buffer) => {
    if (!data.slice(0, HTTP_RESPONSE_HEAD_CHARS.length).equals(HTTP_RESPONSE_HEAD_CHARS)) return;
    const headerEnd = data.indexOf(PACKAGE_TAIL);
    if (headerEnd >= 0) {
        const lines = String(data.slice(0, headerEnd))
            .split('\r\n')
            .filter((v) => v);
        const firstLine = lines.shift();
        if (!firstLine) return undefined;
        const [version, code, ...status] = firstLine.split(' ');
        const header = lines.reduce((res, line) => {
            const [k, v] = line.split(':');
            res[k.toLowerCase()] = v.trim();
            return res;
        }, {} as { [k: string]: string });
        return {
            version,
            code,
            status: status.join(' '),
            header,
            contentStart: headerEnd + PACKAGE_TAIL.length,
        };
    }
};

export class ProtocolHttp extends ProtocolBase {
    method = '';
    version = '';
    isConnect = false;
    protocol = 'http'; // Or https.
    recvDatas: Buffer[] = [];
    dAndPHistory: string[] = [];
    async process(data: Buffer): Promise<undefined | ProtocolHttp> {
        const domainAndPort = parseAddrAndPort(data);
        if (!domainAndPort) return undefined;
        Object.assign(this, domainAndPort);
        this.isConnect = this.method.toUpperCase() === CODE_CONNECT;
        // If it's a connect packet, this connection is probably https.
        if (!this.protocol) this.protocol = this.isConnect ? 'https' : 'http';
        if (this.isConnect) this.minCountShouldIdleTimeoutRecv = 1;
        this.recvDatas.push(data);
        return this;
    }
    async doFailFeedback() {
        this.sock.write(CONNECT_FAILED_FEEDBACK);
    }
    async doConnectedFeedback() {
        this.sock.write(CONNECTED_FEEDBACK);
    }
    judgeWinDataAcceptable = (data: Buffer, target: Target) => {
        if (!data.slice(0, HTTP_RESPONSE_HEAD_CHARS.length).equals(HTTP_RESPONSE_HEAD_CHARS))
            return true;
        const lineEnd = data.indexOf(LINE_END);
        if (lineEnd > 1000) return true;
        logger.log(LogLevel.detail, target, this, () => [
            'judgeWinDataAcceptable',
            !String(data.slice(0, lineEnd)).includes('502'),
        ]);
        return !String(data.slice(0, lineEnd)).includes('502');
    };
    takeOver(targets: DomainChannelStats[]) {
        let recvDataCount = 0;
        let backDataCount = 0;
        const { isConnect, sock } = this;
        const dAndP = this.addr + ':' + this.port;
        const destSock = this.connectFunc(targets, this);
        type RSockStatus = { dataLenRest?: number; toClose: boolean };
        const checkToForceDestroy = () => {
            if (Settings.forceSeperateHttpRequest) {
                logger.log(
                    LogLevel.detail,
                    targets[0].target,
                    this,
                    'forceSeperateHttpRequest',
                    targets,
                );
                safeCloseSocket(sock);
            }
        };
        /**
         * ${isConnect === false} means this is a http (not https) proxy request, which may recieve requests for multi domain.
         * In this case, it's necessary to create multi destSocks for different domain.
         * Use this map to store domain-sock mapping relations;
         */
        const restDestSockMap = isConnect ? null : new Map([[dAndP, destSock]]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const genDestEnd =
            (dAndP: string, rsock: LogicSocket, isError = false) =>
            (err?: any) => {
                const destroy = () => {
                    if (isError) {
                        sock.write(CONNECT_FAILED_FEEDBACK);
                        rsock.destroy();
                    }
                    safeCloseSocket(sock);
                    if (isError)
                        logger.error(
                            ErrorLevel.warn,
                            rsock.getCurrentTarget,
                            this,
                            'Target sockets error',
                            err,
                            recvDataCount,
                            targets,
                        );
                    else
                        logger.log(
                            LogLevel.detail,
                            rsock.getCurrentTarget,
                            this,
                            'Target socks end',
                            recvDataCount,
                            backDataCount,
                            targets,
                        );
                };
                if (!restDestSockMap) destroy();
                else {
                    restDestSockMap.get(dAndP)?.destroy();
                    restDestSockMap.delete(dAndP);
                    if (!restDestSockMap.size) destroy();
                    else checkToForceDestroy();
                }
            };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const genEnd = (isError: boolean) => (err?: any) => {
            if (isError) {
                logger.error(
                    ErrorLevel.warn,
                    undefined,
                    this,
                    'Client socket error',
                    err,
                    backDataCount,
                    targets,
                );
                safeCloseSocket(sock);
            } else
                logger.log(
                    LogLevel.detail,
                    undefined,
                    this,
                    'Client socket end',
                    backDataCount,
                    targets,
                );
            if (!restDestSockMap) destSock.destroy();
            else Array.from(restDestSockMap.values()).forEach((s) => s.destroy());
        };
        const genOnDataBack = (rsock: LogicSocket, dAndP: string) => {
            let status: RSockStatus | null = null;
            return (data: Buffer) => {
                recvDataCount++;
                if (isConnect || !lastDAndP || dAndP === lastDAndP) sock.write(data);
                if (lastDAndP && lastDAndP !== dAndP)
                    logger.error(
                        ErrorLevel.dangerous,
                        rsock.getCurrentTarget,
                        this,
                        'dAndP conflict with lastDAndP',
                        dAndP,
                        lastDAndP,
                    );
                if (!isConnect) {
                    if (!status) {
                        const head = parseResponseHeader(data);
                        if (head) {
                            status = { toClose: false };
                            logger.log(
                                LogLevel.detail,
                                rsock.getCurrentTarget,
                                this,
                                'Heaser parsed',
                                head,
                                head?.header,
                            );
                            const contentLen = head.header['content-length'];
                            if (contentLen !== undefined) {
                                status.dataLenRest = Number.parseInt(contentLen);
                                status.dataLenRest =
                                    status.dataLenRest - (data.length - head.contentStart);
                            }
                            if (head.header['connection'] === 'close') {
                                logger.log(
                                    LogLevel.detail,
                                    rsock.getCurrentTarget,
                                    this,
                                    'On connection close header',
                                    head,
                                );
                                status.toClose = true;
                            }
                        }
                    } else if (status.dataLenRest !== undefined) {
                        status.dataLenRest -= data.length;
                        logger.log(
                            LogLevel.noisyDetail,
                            rsock.getCurrentTarget,
                            this,
                            'Receive data rest length',
                            status.dataLenRest,
                            status,
                        );
                        if (status.dataLenRest < 0)
                            logger.error(
                                ErrorLevel.dangerous,
                                rsock.getCurrentTarget,
                                this,
                                'Http response rest length become nagetive',
                                status,
                            );
                    }
                    if (
                        (status?.dataLenRest !== undefined && status.dataLenRest < 0) ||
                        (status?.dataLenRest === undefined &&
                            data.slice(-PACKAGE_TAIL.length).includes(PACKAGE_TAIL))
                    ) {
                        if (status?.toClose) {
                            rsock.destroy();
                            restDestSockMap?.delete(dAndP);
                        }
                        checkToForceDestroy();
                        status = null;
                        if (lastDAndP) {
                            logger.error(
                                ErrorLevel.dangerous,
                                rsock.getCurrentTarget,
                                this,
                                'lastDAndP value remains, maybe logic error exist',
                                lastDAndP,
                            );
                            lastDAndP = '';
                        }
                    }
                }
            };
        };
        const bindSock = (rSock: LogicSocket, dAndP: string) => {
            if (isConnect) {
                rSock.on('connect', () => {
                    sock.write(CONNECTED_FEEDBACK);
                });
            }
            rSock.on('end', genDestEnd(dAndP, rSock));
            rSock.on('error', genDestEnd(dAndP, rSock, true));
            rSock.on('data', genOnDataBack(rSock, dAndP));
        };
        bindSock(destSock, dAndP);
        let lastDAndP = this.recvDatas[0].slice(-PACKAGE_TAIL.length).includes(PACKAGE_TAIL)
            ? ''
            : dAndP;
        let firstPacketJudged = false;
        sock.on('data', async (data) => {
            logger.log(LogLevel.noisyDetail, undefined, this, 'Receive data from client', data);
            if (this.isConnect && !firstPacketJudged) {
                firstPacketJudged = true;
                // Judge http or https by first packet.
                const info = parseHttpFirstLine(data);
                if (info) {
                    if (
                        info.version.slice(0, HTTP_LOWER_CASE.length).toLowerCase() ===
                        HTTP_LOWER_CASE
                    )
                        this.protocol = HTTP_LOWER_CASE;
                }
            }
            if (isConnect)
                logger.log(
                    LogLevel.noisyDetail,
                    undefined,
                    this,
                    'Receive data print first line',
                    String(data).split('\n')[0],
                );
            backDataCount++;
            if (restDestSockMap) {
                if (lastDAndP) {
                    const rsock = restDestSockMap.get(lastDAndP);
                    if (rsock) {
                        rsock.write(data);
                    } else {
                        logger.error(
                            ErrorLevel.dangerous,
                            undefined,
                            this,
                            'lastDAndP is set but socket dose no exist in restDestSockMap',
                        );
                    }
                } else {
                    const info = parseAddrAndPort(data);
                    if (!info) {
                        logger.error(
                            ErrorLevel.dangerous,
                            undefined,
                            this,
                            'No parsed info, just send to destSock',
                            data,
                        );
                        destSock.write(data);
                    } else {
                        const { addr, port } = info;
                        const dAndP = `${addr}:${port}`;
                        logger.log(
                            LogLevel.noisyDetail,
                            undefined,
                            this,
                            'new lastDAndP',
                            dAndP,
                            data,
                        );
                        this.dAndPHistory.push(lastDAndP);
                        lastDAndP = dAndP;
                        this.addr = addr;
                        this.port = port;
                        logger.log(
                            LogLevel.noisyDetail,
                            undefined,
                            this,
                            'Swith dAndP',
                            dAndP,
                            this.dAndPHistory,
                        );
                        let sock = restDestSockMap.get(dAndP);
                        if (!sock) {
                            const targets = await getTargets(this.addr, this.port, this);
                            sock = this.connectFunc(targets, this);
                            restDestSockMap.set(dAndP, sock);
                            bindSock(sock, dAndP);
                        }
                        sock.write(data);
                    }
                }
                if (data.slice(-PACKAGE_TAIL.length).includes(PACKAGE_TAIL)) {
                    logger.log(LogLevel.noisyDetail, undefined, this, 'lastDAndP reset');
                    lastDAndP = '';
                }
            } else destSock.write(data);
        });
        sock.on('end', genEnd(false));
        sock.on('error', genEnd(true));
        if (!this.isConnect) destSock.write(this.recvDatas[0]);
    }
    async onLogicConnect(target: Target, targetSock: Socket) {
        if (this.isConnect && !target.notProxy) {
            const res = await writeSocketForAck(
                targetSock,
                this.recvDatas[0],
                target.notProxy ? 1500 : 2500,
            );
            if (!res.includes(CONNECTION_ESTABLISHED))
                throw new ErrorProtocolProcessing(
                    `Establish proxy connection failed: ` + String(res),
                );
            return 1;
        }
        return 0;
    }
    writeToTargetSock(data: Buffer, targetSock: Socket, target: Target) {
        if (!this.isConnect && target.notProxy && target.ip === this.addr) {
            // Remove schema and domain info in http request to avoid 404 error in "python3 -m http.server"
            const spaceAt = data.indexOf(CODE_SPACE);
            if (spaceAt > 0) {
                const secondSpaceAt = data.indexOf(CODE_SPACE, spaceAt + 1);
                if (secondSpaceAt >= 0) {
                    const oldUrl = String(data.slice(spaceAt + 1, secondSpaceAt));
                    const url = oldUrl.replace(/https?:\/\/[^/]*/, '');
                    logger.log(
                        LogLevel.detail,
                        target,
                        this,
                        'Remove request domain',
                        oldUrl,
                        url,
                        data,
                    );
                    data = Buffer.concat([
                        data.slice(0, spaceAt + 1),
                        Buffer.from(url),
                        data.slice(secondSpaceAt),
                    ]);
                }
            }
        }
        targetSock.write(data);
    }
    async doIdleTimeoutVerify(target: Target) {
        const agent = target.notProxy
            ? undefined
            : new HttpsProxyAgent({ port: target.port, host: target.ip });
        return await nFetch(
            `${this.protocol}://${this.addr}${
                [80, 443].includes(this.port) ? '' : ':' + this.port
            }`,
            {
                method: 'GET',
                redirect: 'manual',
                timeout: 2000,
                agent,
            },
        )
            .then((res) => !!res)
            .catch((e) => {
                logger.error(ErrorLevel.debugDetail, target, this, 'Failed to do idle verify', e);
                return false;
            });
    }
}
