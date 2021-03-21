export interface Target {
    ip: string;
    port: number;
    notProxy?: true;
    fixedDomains?: (string | RegExp)[];
}
export const Settings = {
    socketTimeout: 15000,
    proxys: [] as Target[],
    port: 8000,
    host: '0.0.0.0'
};
