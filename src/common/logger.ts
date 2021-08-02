import { Settings, ErrorLevel, Target, LogLevel } from './setting';
import { ProtocolBase } from './types';
import { cyan } from 'colors';
import dayjs from 'dayjs';

const getTimeFormated = () => `[${dayjs().format('YYYY-MM-DD HH:mm:ss.SSS')}] `;

const getLoggerTimeSegment = () => (Settings.loggerTime ? getTimeFormated() : '');

const stringify = (args: any[]) =>
    args.map((v) =>
        !(v instanceof Error) && Number(v?.length) > Settings.loggerFoldToLenLimit
            ? Settings.loggerInfoStringify
                ? `\n${cyan(`[${v.constructor?.name || typeof v} length: ${v.length}]`)}\n${String(
                      v,
                  )}\n`
                : v.length
            : v,
    );

const getTarget = (target?: Target | (() => Target)) =>
    typeof target === 'function' ? target() : target;

export const logger = {
    error(
        level: ErrorLevel,
        target?: Target | (() => Target),
        protocolOrTraceId?: ProtocolBase | string,
        getLogData?: (() => any[]) | any,
        ...args: any[]
    ) {
        let protocol = undefined;
        let traceId = undefined;
        if (protocolOrTraceId instanceof ProtocolBase) {
            protocol = protocolOrTraceId;
            traceId = protocol?.traceId;
        } else if (protocolOrTraceId) traceId = protocolOrTraceId;
        if (
            level > ErrorLevel.off &&
            level <= Settings.errorLevel &&
            Settings.errorFilter(getTarget(target), protocol)
        ) {
            if (typeof getLogData === 'function') args = [...getLogData(), ...args];
            target = getTarget(target);
            console.error(
                `${getLoggerTimeSegment()}Error occurred(${ErrorLevel[level]}) ${
                    protocol?.protocol || ''
                } ${protocol?.addr || ''} (${traceId}):`,
            );
            if (target) console.error('target:', target);
            console.error(...stringify(args));
            console.error('\n');
        }
    },
    log(
        level: LogLevel,
        target?: Target | (() => Target),
        protocolOrTraceId?: ProtocolBase | string,
        getLogData?: (() => any[]) | any,
        ...args: any[]
    ) {
        let protocol = undefined;
        let traceId = undefined;
        if (protocolOrTraceId instanceof ProtocolBase) {
            protocol = protocolOrTraceId;
            traceId = protocol?.traceId;
        } else if (protocolOrTraceId) traceId = protocolOrTraceId;
        if (
            level > LogLevel.off &&
            level <= Settings.logLevel &&
            Settings.logFilter(getTarget(target), protocol)
        ) {
            if (typeof getLogData === 'function') args = [...getLogData(), ...args];
            else args.unshift(getLogData);
            target = getTarget(target);
            console.log(
                `${getLoggerTimeSegment()}Log(${LogLevel[level]}) ${protocol?.protocol || ''} ${
                    protocol?.addr || ''
                } (${traceId}):`,
            );
            if (target) console.error('target:', target);
            console.log(...stringify(args));
            console.log('\n');
        }
    },
    logVital(...args: any[]) {
        console.log(getLoggerTimeSegment(), ...args);
    },
    doseLog: () => Settings.logLevel !== LogLevel.off || Settings.errorLevel !== ErrorLevel.off,
};
