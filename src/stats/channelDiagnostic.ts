import { logger } from './../common/logger';
import { ErrorLevel, getDomainProxy, LogLevel, Settings } from './../common/setting';
import net from 'net';
import { RecordWithTtl, resolve4, resolve6 } from 'dns';
import ping from 'ping';
import path from 'path';
import fs from 'fs';
import { CacheData, DomainChannelStats, DomainStatDesc } from '../common/types';
import {
    batchFilter,
    getIpAddressList,
    getIpv4LanIpVerifier,
    parseDomain,
    realTimeout,
    runWithTimeout,
    unZipipData,
    zipData,
} from '../common/util';
import { debounce } from 'lodash';
import isOnline from 'is-online';

/**
 * Map to store diagnostic infos.
 *
 * DomainChannelStats is sorted by healthy
 *
 * Key is `domain:port` string.
 */
export const domainStatsMap = new Map<string, DomainChannelStats[]>();

export const notExactlyGoodStats = (() => {
    const notGoodDomainMap = new Map<string, number>();
    return {
        countNotGood(domain: string) {
            return notGoodDomainMap.get(domain) || 0;
        },
        feedback(notGood: boolean, domain: string) {
            if (isLanIpv4(domain)) return;
            if (!notGood && !notGoodDomainMap.has(domain)) return;
            let stats = notGoodDomainMap.get(domain) || 0;
            if (notGood) stats++;
            else stats -= 0.25;
            if (stats < 0) notGoodDomainMap.delete(domain);
            else notGoodDomainMap.set(domain, stats);
        },
        /**
         * Clear notGood count of one domain or all.
         */
        clear(domain?: string) {
            if (domain) notGoodDomainMap.delete(domain);
            else notGoodDomainMap.clear();
        },
    };
})();

/**
 * Map to count domain request times and last active time;
 *
 * Key is `domain:port` string.
 */
export let domainStatDescMap = new Map<string, DomainStatDesc>();

const judgeDomainActivity = (desc: DomainStatDesc) => {
    const now = Math.floor(Date.now() / 3600000);
    if (!desc.at) desc.at = now;
    if (desc.at + Settings.cacheDomainLife > now) return true;
    desc.at = now;
    desc.count = Math.floor(desc.count / 3);
    return !!desc.count;
};

export const tryRestoreCache = async () => {
    const cacheFile = path.resolve(Settings.cacheFile);
    if (fs.existsSync(cacheFile)) {
        try {
            const data: CacheData = JSON.parse(
                String(await unZipipData(fs.readFileSync(cacheFile))),
            );
            if (data.domainReqCountsDec) {
                data.domainReqCountsDec = data.domainReqCountsDec.filter(judgeDomainActivity);
                domainStatDescMap = new Map(data.domainReqCountsDec.map((v) => [v.dAndP, v]));
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
            logger.error(
                ErrorLevel.dangerous,
                undefined,
                undefined,
                'Parse cache data failed: ' + e.message,
            );
        }
    }
};

export const trySaveCache = async () => {
    const cacheData: CacheData = {};
    cacheData.domainReqCountsDec = Array.from(domainStatDescMap.values()).sort(
        (a, b) => b.count - a.count,
    );

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
        if (domainStatDescMap.size === lastDomainCount) return;
        if (
            lastUpdatedAt &&
            domainStatDescMap.size - lastDomainCount < 3 &&
            Date.now() - lastUpdatedAt < 10 * 60 * 1000
        )
            return;
        await trySaveCache();
        lastUpdatedAt = Date.now();
        lastDomainCount = domainStatDescMap.size;
    };
})();

const judgeToSaveCacheDebounced = debounce(judgeToSaveCache, 2000);

/**
 * Use ping, tcp-ping tools to test targets and feedBack targets
 * If all target tested, return best two target.
 * Test will be skipped if no proxy defined in Setting.proxys.
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
        const desc = domainStatDescMap.get(dAndP) || { dAndP, count: 0 };
        desc.count++;
        desc.at = Math.floor(Date.now() / 3600000);
        if (desc.count === 1) {
            domainStatDescMap.set(dAndP, desc);
            judgeToSaveCacheDebounced();
        }
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
                if (!Settings.proxys.length || (!forceSync && Settings.pingAsync)) {
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
                    if (!Settings.proxys.length) return;
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
                            lossPct > 0 ||
                            notExactlyGoodStats.countNotGood(domain) >
                                Settings.notExactlyGoodCountLimit
                                ? 'bad'
                                : stats.latency < Settings.maxGoodLatency &&
                                  !notExactlyGoodStats.countNotGood(domain)
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
    const notGoodCount = notExactlyGoodStats.countNotGood(domain);
    // pick stats
    if (statsList[0].status === 'good' && !notGoodCount) return [statsList[0]];
    const filteredStats =
        notGoodCount < Settings.notExactlyGoodCountLimit
            ? statsList.filter((s) => s.status !== 'bad')
            : statsList.filter((s) => !s.target.notProxy);
    const targets = filteredStats.length ? filteredStats : statsList;
    if (targets.length) return targets;
    return statsList;
};

export const getTargets = async (addr: string, port: number) => {
    const target = getDomainProxy(addr);
    if (target) return [new DomainChannelStats(addr, port, `${addr}:${port}`, target)];
    return await diagnoseDomain(addr, port);
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
            let count = [
                resolve4(domain, { ttl: true }, cb),
                ...(Settings.useIpv6 ? [resolve6(domain, { ttl: true }, cb)] : []),
            ].length;
        }),
        Settings.proxys.length ? Settings.dnsTimeout : Infinity,
        [],
    );
    return res;
};

const failedPingRes = {
    host: '',
    alive: false,
    output: '',
    time: Infinity,
    times: [],
    min: 'Infinity',
    max: 'Infinity',
    avg: 'Infinity',
    stddev: '0',
    packetLoss: '100',
    numeric_host: '',
};

export const pingDomain = (domain: string, count = 10): Promise<ping.PingResponse> => {
    const failedRes = { ...failedPingRes, host: domain };
    return runWithTimeout(
        new Promise((r) => {
            ping.promise
                .probe(domain, {
                    v6: domain.includes(':'),
                    timeout: Settings.pingTimeout,
                    extra: ['-c', '' + count, '-i', '0.2'],
                })
                .then(r)
                .catch((e) => {
                    logger.error(
                        ErrorLevel.notice,
                        undefined,
                        undefined,
                        'Error: ping failed:\n\t',
                        domain,
                        e,
                    );
                    r(failedRes);
                });
        }),
        count * 1000,
        failedRes,
    );
};

/**
 * Verify dns ttl.
 * @param reuseThesameIp true to return true if ttl expired but new dns resolve result contains old ip.
 * @param forceExpired true to force verify even ttl remains;
 */
const verifyTtl = async (
    stats: DomainChannelStats[],
    margin = 0,
    reuseThesameIp = true,
    forceExpired = false,
): Promise<boolean> => {
    stats = stats.filter((v) => v.target.notProxy);
    const now = Date.now();
    const expireds = forceExpired
        ? stats
        : stats.filter((v) => v.updateAtMili + v.ttl * 1000 < now + margin);
    if (!expireds.length) return true;
    if (!reuseThesameIp) return false;
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

export let isLanIpv4 = getIpv4LanIpVerifier();

// TODO: find better way to refresh
(() => {
    const waitMilli = 30000;
    const { setTimeout } = realTimeout;
    let lock = '';
    const cycleRefreshTtl = async (ignoreLock = false, forceUpdate = false) => {
        if (lock && !ignoreLock) return;
        if (!(await isOnline())) {
            setTimeout(cycleRefreshTtl, 5000);
            return;
        }
        const mLock = Math.random().toString();
        lock = mLock;
        logger.log(LogLevel.detail, undefined, undefined, 'Domain ttl refresh start');
        if (ignoreLock) realTimeout.clearTimeout(cycleRefreshTtl);
        const start = Date.now();
        const existStats = Array.from(domainStatsMap.values());
        const stats = forceUpdate
            ? existStats
            : await batchFilter(
                  existStats,
                  forceUpdate ? async () => true : async (v) => !(await verifyTtl(v, waitMilli)),
              );
        const worker = async () => {
            if (stats.length) {
                await Promise.all(
                    stats
                        .splice(0, Math.min(Settings.pingBatchCount, 20))
                        .map((v) =>
                            runWithTimeout(
                                diagnoseDomain(v[0].domain, v[0].port, true, true, true),
                                3000,
                                undefined,
                            ),
                        ),
                );
                if (lock !== mLock) return;
                process.nextTick(worker);
            } else {
                logger.log(LogLevel.detail, undefined, undefined, 'Domain ttl refresh done');
                setTimeout(cycleRefreshTtl, waitMilli - (Date.now() - start));
                lock = '';
            }
        };
        worker();
    };
    cycleRefreshTtl();

    // listening for ip change
    let lastIpList: string[] | null = null;
    realTimeout.setInterval(() => {
        const ipList = getIpAddressList();
        if (lastIpList) {
            if (JSON.stringify(lastIpList) !== JSON.stringify(ipList)) {
                logger.log(LogLevel.notice, undefined, undefined, 'System Ip list change');
                notExactlyGoodStats.clear();
                cycleRefreshTtl(true, true);
                isLanIpv4 = getIpv4LanIpVerifier();
            }
        }
        lastIpList = ipList;
    }, 1000);

    // Set interval to judge cached domain life.
    realTimeout.setInterval(() => {
        Array.from(domainStatDescMap.entries()).forEach(([dAndP, desc]) => {
            if (!judgeDomainActivity(desc)) {
                domainStatDescMap.delete(dAndP);
                domainStatsMap.delete(dAndP);
            }
        });
        judgeToSaveCache();
    }, 6000 || 3600000 * 12);
})();
