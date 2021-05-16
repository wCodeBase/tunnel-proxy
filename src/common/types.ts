import { Socket } from 'net';
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

function LogicSocketOn(event: 'end', listener: () => void): void;
function LogicSocketOn(event: 'error', listener: (error: Error) => void): void;
function LogicSocketOn(event: 'connect', listener: () => void): void;
// @ts-ignore
function LogicSocketOn(event: 'data', listener: (data: Buffer) => void): void;

/** Socket with diy connect logic  */
export type LogicSocket = Pick<Socket, 'destroy'> & {
    on: typeof LogicSocketOn;
    write: (data: Buffer) => void;
    getCurrentTarget: () => Target;
};

export type LogicConnect = (targets: DomainChannelStats[], protocol: ProtocolBase) => LogicSocket;

export type SocketTargetPair = { sock: Socket; target: Target };

export class ErrorRaceFail extends Error {}
export class ErrorIdleTimeout extends Error {}
export class ErrorProtocolProcessing extends Error {}

export abstract class ProtocolBase {
    addr = '';
    port = 0;
    sock: Socket;
    connectFunc: LogicConnect;
    traceId = '';
    constructor(sock: Socket, connectFun: LogicConnect, tranceId: string) {
        this.sock = sock;
        this.connectFunc = connectFun;
        this.traceId = tranceId;
    }
    abstract protocol: string;
    /** Process the first package and judge is the correct protocol or not. */
    abstract process(data: Buffer): Promise<undefined | ProtocolBase>;
    abstract doFailFeedback(): Promise<void>;
    abstract takeOver(targets: DomainChannelStats[]): void;
    /**
     * Called when logicConnect connect to a socket.
     * Used to deal with protocol relevant transfer, especially when connect to another proxy.
     * LogicConnect may connect to muilty target and finally choose a best one.
     *
     * This method should return when payload transfer can start.
     *
     * @param target current target used to create socket.
     * @param targetSock current created socket.
     * @returns count of data transfer round.
     */
    abstract onLogicConnect(target: Target, targetSock: Socket): Promise<number>;
    /**
     * If data need addon process, rewrite this method.
     */
    writeToTargetSock(data: Buffer, targetSock: Socket, target: Target) {
        targetSock.write(data);
    }
    /**
     * Verify if idle timeout is caused by bad connection or not.
     */
    abstract doIdleTimeoutVerify(target: Target): Promise<boolean>;
    minCountShouldIdleTimeoutRecv = 0;
}
