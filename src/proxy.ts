import { logger } from './common/logger';
import { raceConnect } from './common/raceConnect';
import { ProtocolHttp } from './protocols/http';
import { ProtocolSocks5 } from './protocols/socks5';
import { DomainChannelStats, ProtocolBase } from './common/types';
import { getTargets, tryRestoreCache, trySaveCache } from './stats/channelDiagnostic';
import net from 'net';
import { ErrorLevel, LogLevel, Settings, isDev } from './common/setting';

async function sockConnect(targets: DomainChannelStats[], protocol: ProtocolBase) {
    if (!targets.length) {
        logger.error(ErrorLevel.dangerous, undefined, protocol, 'Not target passed to sockConnect');
        await protocol.doFailFeedback();
        protocol.sock.destroy();
        return;
    }
    protocol.takeOver(targets);
}

export function startProxy(): void {
    tryRestoreCache();
    let traceIdCount = 0;

    const sockIpHostSet = new Set<string>();

    const server = new net.Server((sock) => {
        const traceId = logger.doseLog() ? `${traceIdCount++}--${Date.now()}` : '';
        const strIpHost = `${sock.remoteAddress}:${sock.remotePort}`;
        if (sockIpHostSet.has(strIpHost)) {
            logger.error(ErrorLevel.dangerous, undefined, traceId, 'Client ip-port pair exist');
        }
        sockIpHostSet.add(strIpHost);
        sock.on('end', () => {
            sockIpHostSet.delete(strIpHost);
        });
        sock.once('data', async (data: Buffer) => {
            logger.log(LogLevel.noisyDetail, undefined, traceId, 'On origin data.', data);
            let protocol: ProtocolBase | undefined;
            try {
                for (const Protocol of [ProtocolSocks5, ProtocolHttp]) {
                    protocol = await new Protocol(sock, raceConnect, traceId).process(data);
                    if (protocol) break;
                }
            } catch (e) {
                sock.destroy();
                logger.error(
                    ErrorLevel.important,
                    undefined,
                    protocol,
                    'Error occured while processing first data: ',
                    e,
                );
                protocol = undefined;
            }
            if (!protocol) {
                // TODO: 返回错误信息, 可开关
                sock.destroy();
                return;
            }
            const { addr, port } = protocol;
            const targets = await getTargets(addr, port);
            logger.log(LogLevel.detail, undefined, protocol, 'New request', targets);
            sockConnect(targets, protocol);
        });
    });
    server.listen(Settings.port, Settings.host);
    logger.logVital(`Proxy listening on ${Settings.host}:${Settings.port}`);
    if (isDev) logger.logVital('Proxy is running in development mode');
    const doExit = async () => {
        logger.logVital('Proxy exiting, waiting for cache saving ...');
        await trySaveCache();
        logger.logVital('Cache saved, exist process ...');
        process.exit();
    };
    process.on('SIGINT', doExit);
    process.on('SIGTERM', doExit);
}
