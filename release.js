/**
 * TODO: major, minor version
 */
const fs = require('fs');
const shell = require('shelljs');
const masterBranchs = ['master', 'main'];
const packageJsonInfo = require('./package.json');
const packageJsonInfoStr = JSON.stringify(packageJsonInfo, null, 2);
const curVersion = packageJsonInfo.version;
const curBranch = shell.exec('git branch --show-current', { silent: true }).trim();
let [major = 0, minor = 0, build = 0, tag, tagVersion = 0] = curVersion.split(/[.-]/);

if (masterBranchs.includes(curBranch)) {
    if (!tag) build++;
    tag = undefined;
} else {
    if (curBranch === tag) tagVersion++;
    else tagVersion = 0;
    tag = curBranch;
}

let newVersion = `${major}.${minor}.${build}`;
if (tag) newVersion += `-${tag}-${tagVersion}`;

packageJsonInfo.version = newVersion;
fs.writeFileSync('./package.json', JSON.stringify(packageJsonInfo, null, 2));

const res = shell.exec(
    'tsc && npm publish --registry https://registry.npmjs.org/' + (tag ? ` --tag ${tag}` : ''),
);
if (res.code === 0) console.log('release done');
else {
    console.error('ERROR: release failed');
    fs.writeFileSync('./package.json', packageJsonInfoStr);
}
