#!/usr/bin/env node
import { Settings, isDev } from './common/setting';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { startProxy } from './proxy';
const program = new Command();

program
    .version(require('../package.json').version)
    .option('-p, --port <port number>', 'Port to listen on')
    .option('-h, --host <host>', 'Host to bind, default 0.0.0.0')
    .option('-c, --config <config file path>', 'use a config file')
    .option(
        '-C, --cache <cache file path>',
        'Use a cache file for statistics saving and restoring, ./tunnel-proxy-cache.bin by default',
    )
    .parse(process.argv);

const exitWithError = (error: string) => {
    console.error(error);
    process.exit();
};

const opts = program.opts();

if (opts.port) {
    const port = Number(opts.port);
    if (Number.isInteger(port)) Settings.port = port;
    else exitWithError('Illegal port number');
}

if (opts.host) Settings.host = opts.host;

if (opts.cache) Settings.cacheFile = opts.cache;

if (opts.config) {
    const configPath = path.resolve(opts.config);
    if (!fs.existsSync(configPath)) exitWithError('Config file not found');
    try {
        const config = require(configPath);
        Object.assign(Settings, config);
    } catch (e) {
        exitWithError(`Illegal config file: ${e.message}`);
    }
}

startProxy();

if (isDev) {
    try {
        require('../dev/settingOverride');
    } catch (e) {
        console.error(`Require "./dev/settingOverride" failed`, e);
    }
}
