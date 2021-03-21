# tunnel-proxy
A simple HTTP proxy and smart proxy relay, choose the fastest way between direct http connection and setted proxies.

## usage
```
# install 
npm install -g tunnel-proxy

# usage
tunnel-proxy -p 8000

# use with a config file
tunnel-proxy -c <config file>
```

## config file options

### sample:
Use 'proxys' option to set forward proxies.
```
{
  socketTimeout: 15000,
  proxys: [
    {
      ip: "127.0.0.1",
      port: 8888,
      fixedDomains: [/.*github.com/, 'www.google.com']
    },
  ],
  port: 8000
}
```