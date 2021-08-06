/**
 * Protocol processor for Socks5
 */

import { chunk } from 'lodash';
import { Socket } from 'net';
import nFetch from 'node-fetch';
import { logger } from '../common/logger';
import { ErrorLevel, Target } from '../common/setting';
import { DomainChannelStats, ErrorProtocolProcessing, ProtocolBase } from './../common/types';
import { writeSocketForAck } from './../common/util';

const NO_AUTH_ACK = Buffer.from([5, 0]);
const NO_AUTH_REQ = Buffer.from([5, 1, 0]);

const parseAddrPort = (data: Buffer) => {
    let resData: Buffer, addr: string;
    // TODO: important check ipv6 and ipv4 addr
    if (data[3] === 1) {
        addr = data.slice(4, 8).join('.');
        resData = data.slice(8);
    } else if (data[3] === 3) {
        const end = 5 + data[4];
        addr = String(data.slice(5, end));
        // TODO: check chinese char.
        resData = data.slice(end);
    } else if (data[3] === 4) {
        addr = chunk(
            Array.from(data.slice(4, 20)).map((v) => v.toString(16).padStart(2, '0')),
            2,
        )
            .map((v) => v.join(''))
            .join(':');
        // TODO: check ipv6.
        resData = data.slice(20);
    } else {
        throw new ErrorProtocolProcessing('Parse socks5 addr failed');
    }
    if (resData.length !== 2)
        throw new ErrorProtocolProcessing('Parse socks5 port failed: illegal data length');
    return { addr, port: resData.readUInt16BE() };
};
/**
 * Minimal socks5 protocol implemention.
 *
 * TODO: Authority method implemention.
 */
export class ProtocolSocks5 extends ProtocolBase {
    recvDatas: Buffer[] = [];
    protocol = 'socks5';
    targetPackage: Buffer | null = null;
    async process(data: Buffer): Promise<undefined | ProtocolSocks5> {
        if (data[0] === 5 && data.length === 2 + data[1]) {
            this.recvDatas.push(data);
            const recv = await writeSocketForAck(this.sock, NO_AUTH_ACK).catch<false>((e) => false);
            if (!recv || recv[0] !== 5)
                throw new ErrorProtocolProcessing('Socks5 communication error');
            if (recv[1] !== 1) throw new ErrorProtocolProcessing('Unsupported socks5 method');
            Object.assign(this, parseAddrPort(recv));
            this.recvDatas.push(recv);
            this.targetPackage = recv;
            return this;
        }
    }
    doFeedBack(code: number) {
        if (this.targetPackage) {
            const ack = Buffer.from(this.targetPackage);
            ack[1] = code;
            this.sock.write(ack);
        }
    }
    /** TODO: dose socks5 need fail feedback? */
    async doFailFeedback() {
        this.doFeedBack(4);
    }
    async doConnectedFeedback() {
        this.doFeedBack(0);
    }
    takeOver(targets: DomainChannelStats[]) {
        const destSock = this.connectFunc(targets, this);
        destSock.on('data', (data) => this.sock.write(data));
        destSock.on('end', () => this.sock.destroy());
        destSock.on('error', () => {
            this.sock.destroy();
        });
        destSock.on('connect', () => this.doConnectedFeedback());
        this.sock.on('data', (data) => {
            destSock.write(data);
        });
        this.sock.on('end', destSock.destroy);
        this.sock.on('error', () => {
            destSock.destroy();
        });
    }
    async onLogicConnect(target: Target, targetSock: Socket) {
        if (!target.notProxy) {
            let ack = await writeSocketForAck(targetSock, NO_AUTH_REQ, 1500);
            if (!ack.equals(NO_AUTH_ACK))
                throw new ErrorProtocolProcessing('Socks5 error: unknown ack from next proxy');
            if (!this.targetPackage)
                throw new ErrorProtocolProcessing('Socks5 error: lack targetPackage');
            ack = await writeSocketForAck(targetSock, this.targetPackage, 2500);
            if (ack[0] !== 5 || ack[1] !== 0 || !ack.slice(2).equals(this.targetPackage.slice(2))) {
                throw new ErrorProtocolProcessing('Socks5 error: wrong ack message');
            }
            return 2;
        }
        return 0;
    }
    async doIdleTimeoutVerify(target: Target) {
        // TODO: verify through next proxy if necessary.
        if (!target.notProxy) return true;
        return await nFetch(
            `${this.port === 443 ? 'https' : 'http'}://${this.addr}${
                [80, 443].includes(this.port) ? '' : ':' + this.port
            }`,
            {
                method: 'GET',
                redirect: 'manual',
                timeout: 2000,
            },
        )
            .then((res) => !!res)
            .catch((e) => {
                logger.error(ErrorLevel.debugDetail, target, this, 'Failed to do idle verify', e);
                return false;
            });
    }
}
