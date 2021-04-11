import { Settings } from './../common/setting';
import net from 'net';
import { RecordWithTtl, resolve4, resolve6 } from 'dns';
import ping from 'ping';
import path from 'path';
import fs from 'fs';
import { CacheData, DomainChannelStats } from './types';
import { parseDomain, runWithTimeout, unZipipData, zipData } from '../common/util';
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
                        .splice(0, Settings.pingBatchCount)
                        .filter((d) => !domainStatsMap.has(d.dAndP));
                    await Promise.all(
                        toPing.map((d) => {
                            const dAndP = parseDomain(d.dAndP);
                            return runWithTimeout(
                                diagnoseDomain(dAndP.domain, dAndP.port, false, true, true),
                                3000,
                                undefined,
                            );
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
    ignoreCount = false,
) => {
    const dAndP = `${domain}:${port}`;
    if (!ignoreCount) {
        const reqCount = domainReqCountMap.get(dAndP) || 0;
        if (!reqCount) judgeToSaveCacheDebounced();
        domainReqCountMap.set(dAndP, reqCount + 1);
    }
    let statsList = rediagnose ? [] : domainStatsMap.get(dAndP) || [];
    if (!statsList.length || !(await verifyTtl(statsList))) {
        Settings.proxys.forEach((target) =>
            statsList.push(new DomainChannelStats(domain, port, dAndP, target)),
        );
        await new Promise(async (r) => {
            const mStatsList = [...statsList];
            const ips = await resolveDomainIps(domain);
            if (ips.length) {
                if (!forceSync && Settings.pingAsync) {
                    statsList.push(
                        new DomainChannelStats(
                            domain,
                            port,
                            dAndP,
                            { ip: ips[0].address, port, notProxy: true },
                            ips[0].ttl,
                        ),
                    );
                    r(undefined);
                }
                const pingResList = await Promise.all(ips.map((ip) => pingDomain(ip.address)));
                const localStatsis: DomainChannelStats[] = [];
                pingResList.forEach((res, i) => {
                    const lossPct =
                        // @ts-ignore
                        res.packetLoss === 'unknown' ? Infinity : Number(res.packetLoss);
                    if (lossPct <= Settings.maxPkgLossPct) {
                        const stats = new DomainChannelStats(
                            domain,
                            port,
                            dAndP,
                            {
                                ip: ips[i].address,
                                port,
                                notProxy: true,
                            },
                            ips[i].ttl,
                        );
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
                if (!forceSync && Settings.pingAsync) {
                    if (mStatsList.length) domainStatsMap.set(dAndP, mStatsList);
                } else {
                    statsList = mStatsList;
                    r(undefined);
                }
            }
        });
    }

    if (!statsList.length) {
        const oldStats = domainStatsMap.get(dAndP);
        if (!oldStats?.length) return [];
        else statsList = oldStats;
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

const stuckResolveDomainMap = new Map<string, ((res: RecordWithTtl[]) => void)[]>();

// TODO: some domain's dns resolving  cost more than tens of seconds
export const resolveDomainIps = async (domain: string): Promise<RecordWithTtl[]> => {
    if (net.isIP(domain)) return [{ address: domain, ttl: Infinity }];
    const res = await runWithTimeout(
        new Promise<RecordWithTtl[]>((resolve) => {
            const stucks = stuckResolveDomainMap.get(domain) || [];
            stucks.push(resolve);
            if (stucks.length === 1) stuckResolveDomainMap.set(domain, stucks);
            else return;
            const r = (res: RecordWithTtl[]) => {
                (stuckResolveDomainMap.get(domain) || []).forEach((resolve) => resolve(res));
                stuckResolveDomainMap.delete(domain);
            };
            const cb = (err: NodeJS.ErrnoException | null, ips: RecordWithTtl[]) => {
                count--;
                if (err || !ips.length) {
                    if (!count) r([]);
                } else r(ips);
            };
            let count = [resolve4(domain, { ttl: true }, cb), resolve6(domain, { ttl: true }, cb)]
                .length;
        }),
        Settings.proxys.length ? Settings.dnsTimeout : Infinity,
        [],
    );
    return res;
};

export const pingDomain = (domain: string, count = 10): Promise<ping.PingResponse> => {
    return new Promise((r) => {
        ping.promise
            .probe(domain, {
                timeout: Settings.pingTimeout,
                extra: ['-c', '' + count, '-i', '0.2'],
            })
            .then(r);
    });
};

const verifyTtl = async (stats: DomainChannelStats[], margin = 0): Promise<boolean> => {
    const now = Date.now();
    const expireds = stats.filter((v) => v.updateAtMili + v.ttl * 1000 < now + margin);
    if (!expireds.length) return true;
    const res = await new Promise<boolean>((r) => {
        let count = expireds.length;
        expireds.forEach(async (st) => {
            const res = await resolveDomainIps(st.domain);
            if (count) {
                count--;
                if (!res.find((ip) => ip.address === st.target.ip)) {
                    count = 0;
                    r(false);
                } else {
                    st.updateAtMili = Date.now();
                    if (count <= 0) {
                        r(true);
                    }
                }
            }
        });
    });
    return res;
};

// TODO: find better way to refresh
(() => {
    const waitMilli = 30000;
    const cycleRefreshTtl = async () => {
        const start = Date.now();
        const stats = Array.from(domainStatsMap.values()).filter(
            async (v) => !(await verifyTtl(v, waitMilli)),
        );
        const worker = async () => {
            if (stats.length) {
                await Promise.all(
                    stats
                        .splice(0, Settings.pingBatchCount)
                        .map(
                            async (v) =>
                                await diagnoseDomain(v[0].domain, v[0].port, true, true, true),
                        ),
                );
                process.nextTick(worker);
            } else {
                setTimeout(cycleRefreshTtl, waitMilli - (Date.now() - start));
            }
        };
        worker();
    };
    cycleRefreshTtl();
})();
