import { Settings } from './../common/setting';
import net from 'net';
import { resolve } from 'dns';
import ping from 'ping';
import path from 'path';
import fs from 'fs';
import { CacheData, DomainChannelStats } from './types';
import { parseDomain, unZipipData, zipData } from '../common/util';
import { debounce } from 'lodash';

/**
 * Map to store diagnostic infos.
 *
 * DomainChannelStats is sorted by healthy
 *
 * Key is `domain:port` string.
 */
export const domainStatsMap = new Map<string, DomainChannelStats[]>();

/**
 * Map to count domain request times;
 *
 * Key is `domain:port` string.
 */
export let domainReqCountMap = new Map<string, number>();

export const tryRestoreCache = async () => {
    const cacheFile = path.resolve(Settings.cacheFile);
    if (fs.existsSync(cacheFile)) {
        try {
            const data: CacheData = JSON.parse(
                String(await unZipipData(fs.readFileSync(cacheFile))),
            );
            if (data.domainReqCountsDec) {
                domainReqCountMap = new Map(data.domainReqCountsDec.map((v) => [v.dAndP, v.count]));

                // Ping test after start
                const dataToPing = Array.from(data.domainReqCountsDec);
                const pingTest = async () => {
                    const toPing = dataToPing
                        .splice(0, 30)
                        .filter((d) => !domainStatsMap.has(d.dAndP));
                    await Promise.all(
                        toPing.map((d) => {
                            const dAndP = parseDomain(d.dAndP);
                            return diagnoseDomain(dAndP.domain, dAndP.port, false, true);
                        }),
                    );
                    if (!dataToPing.length) return;
                    else process.nextTick(pingTest);
                };
                process.nextTick(pingTest);
            }
        } catch (e) {
            console.error('Parse cache data failed: ' + e.message);
        }
    }
};

export const trySaveCache = async () => {
    const cacheData: CacheData = {};
    cacheData.domainReqCountsDec = Array.from(domainReqCountMap)
        .map((p) => ({ dAndP: p[0], count: p[1] }))
        .sort((a, b) => b.count - a.count);

    try {
        fs.writeFileSync(Settings.cacheFile, await zipData(Buffer.from(JSON.stringify(cacheData))));
    } catch (e) {
        console.error('Save cache data failed: ' + e.message);
    }
};

export const judgeToSaveCache = (() => {
    let lastUpdatedAt = 0;
    let lastDomainCount = 0;
    return async () => {
        if (domainReqCountMap.size === lastDomainCount) return;
        if (
            lastUpdatedAt &&
            domainReqCountMap.size - lastDomainCount < 3 &&
            Date.now() - lastUpdatedAt < 10 * 60 * 1000
        )
            return;
        await trySaveCache();
        lastUpdatedAt = Date.now();
        lastDomainCount = domainReqCountMap.size;
    };
})();

const judgeToSaveCacheDebounced = debounce(judgeToSaveCache, 2000);

/**
 * Use ping, tcp-ping tools to test targets and feedBack targets
 * If all target tested, return best two target
 * TODO: auto rediagnose
 * TODO: spread test on next tunnel-proxy node
 */
export const diagnoseDomain = async (
    domain: string,
    port: number,
    rediagnose = false,
    forceSync = false,
) => {
    const dAndP = `${domain}:${port}`;
    const reqCount = domainReqCountMap.get(dAndP) || 0;
    if (!reqCount) judgeToSaveCacheDebounced();
    domainReqCountMap.set(dAndP, reqCount + 1);
    let statsList = rediagnose ? [] : domainStatsMap.get(dAndP) || [];
    if (!statsList.length) {
        Settings.proxys.forEach((target) => statsList.push(new DomainChannelStats(dAndP, target)));
        await new Promise(async (r) => {
            const mStatsList = [...statsList];
            const ips = await resolveDomainIps(domain);
            if (ips.length) {
                if (!forceSync && Settings.pingAsync) {
                    statsList.push(
                        new DomainChannelStats(dAndP, { ip: ips[0], port, notProxy: true }),
                    );
                    r(undefined);
                }
                const pingResList = await Promise.all(ips.map((ip) => pingDomain(ip)));
                const localStatsis: DomainChannelStats[] = [];
                pingResList.forEach((res, i) => {
                    const lossPct =
                        // @ts-ignore
                        res.packetLoss === 'unknown' ? Infinity : Number(res.packetLoss);
                    if (lossPct <= Settings.maxPkgLossPct) {
                        const stats = new DomainChannelStats(dAndP, {
                            ip: ips[i],
                            port,
                            notProxy: true,
                        });
                        stats.latency = res.time === 'unknown' ? Infinity : res.time;
                        stats.pkgLostPct = lossPct;
                        stats.status =
                            lossPct > 0
                                ? 'bad'
                                : stats.latency < Settings.maxGoodLatency
                                ? 'good'
                                : 'work';
                        localStatsis.push(stats);
                    }
                });
                if (localStatsis.length) {
                    localStatsis
                        .sort((a, b) => a.pkgLostPct - b.pkgLostPct)
                        .slice(0, 2)
                        .forEach((s) => {
                            if (s.status === 'good') mStatsList.unshift(s);
                            else mStatsList.push(s);
                        });
                }
                if (!forceSync && Settings.pingAsync) domainStatsMap.set(dAndP, mStatsList);
                else {
                    statsList = mStatsList;
                    r(undefined);
                }
            }
        });
    }
    domainStatsMap.set(dAndP, statsList);

    // pick stats
    if (statsList[0].status === 'good') return [statsList[0].target];
    const targets = statsList.filter((s) => s.status !== 'bad').map((s) => s.target);
    if (targets.length) return targets;
    return statsList.map((s) => s.target);
};

// TODO:
//export const targetFeedBack = (target: Target, latency: number) => {};

export const resolveDomainIps = async (domain: string): Promise<string[]> => {
    if (net.isIP(domain)) return [domain];
    return await new Promise((r) => {
        resolve(domain, (err, ips) => {
            if (err || !ips.length) r([]);
            r(ips);
        });
    });
};
export const pingDomain = (domain: string, count = 10): Promise<ping.PingResponse> => {
    return new Promise((r) => {
        ping.promise
            .probe(domain, { timeout: 0.3, extra: ['-c', '' + count, '-i', '0.2'] })
            .then(r);
    });
};
