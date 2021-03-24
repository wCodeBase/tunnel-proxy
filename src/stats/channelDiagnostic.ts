import { Target, Settings } from './../common/setting';
import net from 'net';
import { resolve } from 'dns';
import ping from 'ping';

export const CHANNEL_LOCAL = 'local';

class DomainChannelStats {
    domain: string;
    target: Target;
    updateAtMili = 0;
    pkgLostPct = -1;
    /** 0 means not tested yet */
    latency = 0;
    status: 'good' | 'work' | 'bad' = 'work';
    constructor(domain: string, target: Target) {
        this.domain = domain;
        this.target = target;
        this.updateAtMili = Date.now();
    }
}

/**
 * Map to store diagnostic infos.
 * DomainChannelStats is sorted by healthy
 */
export const domainStatsMap = new Map<string, DomainChannelStats[]>();

/**
 * Use ping, tcp-ping tools to test targets and feedBack targets
 * If all target tested, return best two target
 * TODO: auto rediagnose
 * TODO: spread test on next tunnel-proxy node
 */
export const diagnoseDomain = async (domain: string, port: number, rediagnose = false) => {
    const stats = rediagnose ? [] : domainStatsMap.get(domain) || [];
    if (!stats.length) {
        Settings.proxys.forEach((target) => stats.push(new DomainChannelStats(domain, target)));
        const ips = await resolveDomainIps(domain);
        if (ips.length) {
            const pingResList = await Promise.all(ips.map((ip) => pingDomain(ip)));
            const localStatsis: DomainChannelStats[] = [];
            pingResList.forEach((res, i) => {
                // @ts-ignore
                const lossPct = res.packetLoss === 'unknown' ? Infinity : Number(res.packetLoss);
                if (lossPct <= Settings.maxPkgLossPct) {
                    const stats = new DomainChannelStats(domain, {
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
                localStatsis.sort((a, b) => a.pkgLostPct - b.pkgLostPct).slice(0, 2);
            }
        }
    }
    domainStatsMap.set(domain, stats);

    // pick stats
    if (stats[0].status === 'good') return [stats[0].target];
    const targets = stats
        .slice(0, 2)
        .filter((s) => s.status !== 'bad')
        .map((s) => s.target);
    if (targets.length) return targets;
    return stats.map((s) => s.target);
};

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
