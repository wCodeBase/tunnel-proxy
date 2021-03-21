#!/usr/bin/env node
import { Settings } from './common/setting';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { startProxy } from './proxy';
const program = new Command();

program
    .version('0.0.7')
    .option('-p, --port <port number>', 'port to listen on')
    .option('-h, --host <host>', 'host to bind, default 0.0.0.0')
    .option('-c, --config <config file path>', 'use a config file')
    .parse(process.argv);

const existWithError = (error: string) => {
    console.error(error);
    process.exit();
};

const opts = program.opts();

if (opts.port) {
    const port = Number(opts.port);
    if (Number.isInteger(port)) Settings.port = port;
    else existWithError('Illegal port number');
}

if (opts.host) Settings.host = opts.host;

if (opts.config) {
    const configPath = path.resolve(opts.config);
    if (!fs.existsSync(configPath)) existWithError('Config file not found');
    try {
        const config = require(configPath);
        Object.assign(Settings, config);
    } catch (e) {
        existWithError(`Illegal config file: ${e.message}`);
    }
}

startProxy();
