export const config = {
    runner: 'local',
    specs: ['./test/specs/**/*.e2e.js'],
    maxInstances: 1,
    capabilities: [{
        browserName: 'chrome',
        'goog:chromeOptions': {
            args: ['--headless=new', '--no-sandbox', '--disable-gpu']
        }
    }],
    logLevel: 'error',
    waitforTimeout: 10000,
    framework: 'mocha',
    reporters: [],
    mochaOpts: {
        timeout: 60000
    }
}
