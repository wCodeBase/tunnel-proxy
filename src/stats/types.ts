import { Target } from '../common/setting';

export const CHANNEL_LOCAL = 'local';

export class DomainChannelStats {
    dAndP: string;
    domain: string;
    port: number;
    target: Target;
    updateAtMili = 0;
    ttl: number;
    pkgLostPct = -1;
    /** 0 means not tested yet */
    latency = 0;
    /** feedback latency from raceConnect */
    lastFeedbackLatency = 0;
    status: 'good' | 'work' | 'bad' = 'work';
    constructor(domain: string, port: number, dAndP: string, target: Target, ttl?: number) {
        this.domain = domain;
        this.port = port;
        this.dAndP = dAndP;
        this.target = target;
        this.updateAtMili = Date.now();
        if (ttl === undefined) this.ttl = Infinity;
        else this.ttl = ttl;
    }
}

export interface DomainStatDesc {
    /** domain with port (`domain:port`) */
    dAndP: string;
    count: number;
    /** Last active time, by the hour */
    at?: number;
}

export interface CacheData {
    domainReqCountsDec?: DomainStatDesc[];
}

export class ErrorRaceFail extends Error {}
export class ErrorIdleTimeout extends Error {}
