const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
export function genRandomString(length: number) {
    let res = '';
    while (length--) res += chars[Math.floor(Math.random() * chars.length)];
    return res;
}
