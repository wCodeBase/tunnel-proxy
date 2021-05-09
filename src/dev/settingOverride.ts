import { ProtocolHttp } from './../protocols/http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ErrorLevel, LogLevel, Settings } from '../common/setting';
import { ProtocolSocks5 } from '../protocols/socks5';
Settings.logFilter = (target, protocol) => {
    return !protocol || (protocol instanceof ProtocolHttp && !!protocol.addr.match(/.*github.com/));
};
Settings.errorFilter = (target, protocol) => {
    // return protocol instanceof ProtocolSocks5;
    return !protocol || (protocol instanceof ProtocolHttp && !!protocol.addr.match(/.*github.com/));
};
Settings.logLevel = LogLevel.all;
Settings.errorLevel = ErrorLevel.all;
// Settings.loggerInfoStringify=true;
