import { logger } from './../common/logger';

/***
 * Protocol processor for http and https.
 **/

import { writeSocketForAck } from './../common/util';
import nFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ErrorProtocolProcessing, LogicSocket } from './../common/types';
import { ProtocolBase, DomainChannelStats } from './../common/types';
import { getTargets } from '../stats/channelDiagnostic';
import { ErrorLevel, LogLevel, Settings, Target } from '../common/setting';
import { Socket } from 'net';

const CODE_CONNECT = 'CONNECT';
const MAX_HTTP_METHOD_LENGTH = 10;
const MAX_HTTP_URL_LENGTH = 100000;
const CODE_SPACE = ' '.charCodeAt(0);
const LINE_END = Buffer.from('\r\n');
const PACKAGE_TAIL = Buffer.from('\r\n\r\n');
const CONNECTED_FEEDBACK = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
const CONNECTION_ESTABLISHED = Buffer.from('Connection Established');
const CONNECT_FAILED_FEEDBACK = Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n');

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

export class ProtocolHttp extends ProtocolBase {
    method = '';
    version = '';
    isConnect = false;
    protocol = 'http'; // Or https, depends on result of "parseAddrAndPort".
    recvDatas: Buffer[] = [];
    async process(data: Buffer): Promise<undefined | ProtocolHttp> {
        const domainAndPort = parseAddrAndPort(data);
        if (!domainAndPort) return undefined;
        Object.assign(this, domainAndPort);
        this.isConnect = this.method.toUpperCase() === CODE_CONNECT;
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
    takeOver(targets: DomainChannelStats[]) {
        let recvDataCount = 0;
        let backDataCount = 0;
        const { isConnect, sock } = this;
        const dAndP = this.addr + ':' + this.port;
        const destSock = this.connectFunc(targets, this);
        /**
         * ${isConnect === false} means this is a http (not https) proxy request, which may recieve requests for multi domain.
         * In this case, it's necessary to create multi destSocks for different domain.
         * Use this map to store domain-sock mapping relations;
         */
        const restDestSockMap = isConnect ? null : new Map([[dAndP, destSock]]);
        const genDestEnd = (dAndP: string, isError = false) => (err?: any) => {
            const destory = () => {
                if (isError) sock.write(CONNECT_FAILED_FEEDBACK);
                sock.destroy();
                if (isError)
                    logger.error(
                        ErrorLevel.warn,
                        undefined,
                        this,
                        'Target sockets error',
                        err,
                        recvDataCount,
                        targets,
                    );
                else
                    logger.log(
                        LogLevel.detail,
                        undefined,
                        this,
                        'Target socks end',
                        recvDataCount,
                        backDataCount,
                        targets,
                    );
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
        const genEnd = (isError: boolean) => (err?: any) => {
            if (isError)
                logger.error(
                    ErrorLevel.warn,
                    undefined,
                    this,
                    'Client socket error',
                    err,
                    backDataCount,
                    targets,
                );
            else
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
        const onDataBack = (data: Buffer) => {
            recvDataCount++;
            sock.write(data);
        };
        const bindSock = (rSock: LogicSocket) => {
            if (isConnect)
                rSock.on('connect', () => {
                    sock.write(CONNECTED_FEEDBACK);
                });
            rSock.on('end', destEnd);
            rSock.on('error', destError);
            rSock.on('data', onDataBack);
        };
        bindSock(destSock);
        let lastDAndP = this.recvDatas[0].slice(-PACKAGE_TAIL.length).includes(PACKAGE_TAIL)
            ? ''
            : dAndP;
        sock.on('data', async (data) => {
            backDataCount++;
            if (restDestSockMap) {
                if (lastDAndP) {
                    restDestSockMap.get(lastDAndP)?.write(data);
                } else {
                    const info = parseAddrAndPort(data);
                    if (!info) destSock.write(data);
                    else {
                        const { addr, port } = info;
                        const dAndP = `${addr}:${port}}`;
                        lastDAndP = dAndP;
                        let sock = restDestSockMap.get(dAndP);
                        if (!sock) {
                            const targets = await getTargets(this.addr, this.port);
                            sock = this.connectFunc(targets, this);
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
        sock.on('end', genEnd(false));
        sock.on('error', genEnd(true));
        if (!this.isConnect) destSock.write(this.recvDatas[0]);
    }
    async onLogicConnect(target: Target, targetSock: Socket) {
        if (this.isConnect && !target.notProxy) {
            const res = await writeSocketForAck(targetSock, this.recvDatas[0]);
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
                    const url = String(data.slice(spaceAt + 1, secondSpaceAt)).replace(
                        /https?:\/\/[^/]*/,
                        '',
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
            `${this.isConnect ? 'https' : 'http'}://${this.addr}${
                [80, 443].includes(this.port) ? '' : this.port
            }`,
            {
                method: 'GET',
                redirect: 'manual',
                timeout: 2000,
                agent,
            },
        )
            .then((res) => !!res)
            .catch(() => false);
    }
}
