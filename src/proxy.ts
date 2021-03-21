import net, { Socket } from 'net';
import { resolve } from 'dns';
import { Settings, Target } from './common/setting';

const CODE_CONNECT = 'CONNECT';
const MAX_HTTP_METHOD_LENGTH = 10;
const MAX_HTTP_URL_LENGTH = 10000;
const CODE_SPACE = ' '.charCodeAt(0);
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

/**
 * 通过比较第一个包的响应时间选取最快的路线
 * TODO: 比对多个包(可设置)的结果来决定用哪个连接(现有问题: github 未走代理)
 * @param connectData 当请求的方法是CONNECT时需传递
 */
function raceConnect(dests: Target[], connectData?: Buffer): RaceSocket {
    const dataCache: Buffer[] = [];
    let msock: Socket | null = null;
    const connectedSocks: Socket[] = [];
    const cbMap: { [index: string]: (...args: Buffer[]) => void } = {};
    const socks: (Socket | null)[] = dests.map((v, i) => {
        let blockDataCount = 0;
        const sock = net.connect(v.port, v.ip, () => {
            if (connectData && !v.notProxy) {
                sock.write(connectData);
                blockDataCount++;
            } else dataCache.forEach((d) => sock.write(d));
        });
        sock.on('data', (data) => {
            if (blockDataCount) {
                // TODO: 解析代理返回的错误
                blockDataCount--;
                if (blockDataCount <= 0) dataCache.forEach((d) => sock.write(d));
                return;
            }
            if (msock) {
                return;
            }
            socks.forEach((v, index) => i !== index && v?.destroy());
            cbMap['connected']?.();
            ['data', 'end', 'error'].forEach((ev) =>
                sock.on(ev, (...args) => cbMap[ev]?.(...args))
            );
            msock = sock;
            cbMap['data']?.(data);
        });
        const fail = () => {
            sock.destroy();
            socks[i] = null;
            if (!socks.find((v) => v)) cbMap['error']?.();
        };
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
        }
    };
}

function sockConnect(sock: Socket, targets: Target[], firstData: Buffer) {
    const isConnect = isConnectedMethod(firstData);
    const connectData = isConnect ? firstData : undefined;
    const destSock = raceConnect(targets, connectData);
    const end = () => sock.destroy();
    destSock.on('end', end);
    destSock.on('error', end);
    destSock.on('data', (data) => sock.write(data));
    sock.on('data', destSock.write);
    sock.on('end', destSock.destroy);
    sock.on('error', destSock.destroy);
    if (connectData) sock.write(CONNECTED_FEEDBACK);
    else destSock.write(firstData);
}

function parseHttpUrl(data: Buffer) {
    const start = data.slice(0, MAX_HTTP_METHOD_LENGTH).indexOf(CODE_SPACE);
    if (start < 0) return null;
    const end = data.slice(start + 1, MAX_HTTP_URL_LENGTH).indexOf(CODE_SPACE);
    if (end < 0) return null;
    return String(data.slice(start + 1, start + end + 1));
}

export function startProxy(): void {
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

    const server = new net.Server((sock) => {
        sock.once('data', (data) => {
            const url = parseHttpUrl(data);
            if (!url) {
                // TODO: 返回错误信息, 可开关
                sock.destroy();
                return;
            }
            const domainAndPort = url
                .replace(/https?:\/\//, '')
                .replace(/\/.*/, '')
                .split(':');
            const domain = domainAndPort[0];
            const target = getDomainProxy(domain);
            if (target) sockConnect(sock, [target], data);
            else
                resolve(domain, (err, ips) => {
                    if (err || !ips.length) {
                        // TODO: 返回错误信息, 可开关
                        sock.destroy();
                        return;
                    }
                    const port = domainAndPort.length > 1 ? Number(domainAndPort[1]) : 80;
                    sockConnect(
                        sock,
                        [...Settings.proxys, { ip: ips[0], port, notProxy: true }],
                        data
                    );
                });
        });
    });
    server.listen(Settings.port, Settings.host);
    console.log(`Proxy listening on ${Settings.host}:${Settings.port}`);
}
