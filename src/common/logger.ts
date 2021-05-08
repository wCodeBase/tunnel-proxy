import { Settings, ErrorLevel, Target, LogLevel } from './setting';
import { ProtocolBase } from './types';
import dayjs from 'dayjs';
const getLoggerTime = () =>
    Settings.loggerTime ? `[${dayjs().format('YYYY-MM-DD HH:mm:ss.SSS')}] ` : '';
export const logger = {
    error(level: ErrorLevel, target?: Target, protocol?: ProtocolBase, ...args: any[]) {
        if (
            level > ErrorLevel.off &&
            level <= Settings.errorLevel &&
            Settings.errorFilter(target, protocol)
        ) {
            console.error(
                `${getLoggerTime()}Error occurred(${ErrorLevel[level]}) ${
                    protocol?.protocol || ''
                } ${protocol?.addr || ''}:`,
            );
            if (target) console.error('target:', target);
            console.error(...args);
        }
    },
    log(level: LogLevel, target?: Target, protocol?: ProtocolBase, ...args: any[]) {
        if (
            level > LogLevel.off &&
            level <= Settings.logLevel &&
            Settings.logFilter(target, protocol)
        ) {
            console.log(
                `${getLoggerTime()}Log(${LogLevel[level]}) ${protocol?.protocol || ''} ${
                    protocol?.addr || ''
                }:`,
            );
            if (target) console.error('target:', target);
            console.log(...args);
        }
    },
};
