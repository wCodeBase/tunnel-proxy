import { Target } from '../common/setting';

export const CHANNEL_LOCAL = 'local';

export class DomainChannelStats {
    dAndP: string;
    target: Target;
    updateAtMili = 0;
    pkgLostPct = -1;
    /** 0 means not tested yet */
    latency = 0;
    /** feedback latency from raceConnect */
    lastFeedbackLatency = 0;
    status: 'good' | 'work' | 'bad' = 'work';
    constructor(dAndP: string, target: Target) {
        this.dAndP = dAndP;
        this.target = target;
        this.updateAtMili = Date.now();
    }
}

export interface CacheData {
    domainReqCountsDec?: {
        /** domain with port (`domain:port`) */
        dAndP: string;
        count: number;
    }[];
}
